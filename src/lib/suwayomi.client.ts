/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'crypto';

import { getConfig, isDegradedConfigObject } from './config';
import {
  MangaChapter,
  MangaDetail,
  MangaFilterSelection,
  MangaRecommendResult,
  MangaSearchFailure,
  MangaRecommendType,
  MangaSearchItem,
  MangaSearchResult,
  MangaSource,
  MangaSourceFilterOption,
  MangaSourceMeasurement,
} from './manga.types';
import {
  isSuwayomiUnknownFieldError,
  MangaSourceForbiddenError,
} from './suwayomi-errors';
import { normalizeApiBaseUrl } from './url';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface SuwayomiClientOptions {
  serverUrl?: string;
  authMode?: 'none' | 'basic_auth' | 'simple_login';
  username?: string;
  password?: string;
}

interface ResolvedSuwayomiConfig {
  serverBaseUrl: string;
  serverUrl: string;
  authMode: 'none' | 'basic_auth' | 'simple_login';
  username?: string;
  password?: string;
  defaultLang: string;
  sourceIds: string[];
  maxSources: number;
  /**
   * admin 設定是否真的讀成功。false = 我們不知道 SourceIds 是什麼，
   * 授權路徑必須 fail closed，不可把「未知」當成「不限制」。
   */
  policyKnown: boolean;
}

interface SuwayomiSessionCacheEntry {
  cookieHeader: string;
  expiresAt: number;
}

const SUWAYOMI_SESSION_TTL_MS = 25 * 60 * 1000;
const DEFAULT_SUWAYOMI_TIMEOUT_MS = Number(process.env.SUWAYOMI_TIMEOUT_MS || 20000);


const suwayomiSessionCache = new Map<string, SuwayomiSessionCacheEntry>();

function normalizeSuwayomiAuthMode(value?: string | null): 'none' | 'basic_auth' | 'simple_login' {
  if (value === 'basic_auth' || value === 'simple_login') {
    return value;
  }
  return 'none';
}

function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function hashSimpleLoginPassword(password?: string): string {
  return createHash('sha256').update(password || '').digest('hex');
}

function getSimpleLoginCacheKey(config: ResolvedSuwayomiConfig): string {
  return `${config.serverBaseUrl}|${config.username || ''}|${hashSimpleLoginPassword(config.password)}`;
}

function getResponseSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const setCookie = response.headers.get('set-cookie');
  return setCookie ? [setCookie] : [];
}

function extractCookieHeader(response: Response): string | null {
  const cookies = getResponseSetCookieHeaders(response)
    .map((item) => item.split(';', 1)[0]?.trim())
    .filter(Boolean) as string[];

  return cookies.length > 0 ? cookies.join('; ') : null;
}

export async function loginWithSimpleAuth(
  config: ResolvedSuwayomiConfig,
  forceRefresh = false
): Promise<string> {
  if (!config.username || !config.password) {
    throw new Error('Suwayomi simple_login 缺少用户名或密码');
  }

  const cacheKey = getSimpleLoginCacheKey(config);
  const cached = suwayomiSessionCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.cookieHeader;
  }

  const response = await fetch(
    `${config.serverBaseUrl}/login.html?redirect=${encodeURIComponent('/api/graphql')}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        user: config.username,
        pass: config.password,
      }).toString(),
      redirect: 'manual',
      cache: 'no-store',
    }
  );

  const cookieHeader = extractCookieHeader(response);
  if (!cookieHeader) {
    throw new Error(`Suwayomi simple_login 登录失败: ${response.status}`);
  }

  suwayomiSessionCache.set(cacheKey, {
    cookieHeader,
    expiresAt: Date.now() + SUWAYOMI_SESSION_TTL_MS,
  });

  return cookieHeader;
}

async function resolveSuwayomiConfig(options: SuwayomiClientOptions = {}): Promise<ResolvedSuwayomiConfig> {
  let serverUrl = process.env.SUWAYOMI_URL || process.env.NEXT_PUBLIC_SUWAYOMI_URL || '';
  let authMode = normalizeSuwayomiAuthMode(process.env.SUWAYOMI_AUTH_MODE);
  let username = process.env.SUWAYOMI_USERNAME || '';
  let password = process.env.SUWAYOMI_PASSWORD || '';
  let defaultLang = process.env.SUWAYOMI_DEFAULT_LANG || 'zh';
  let sourceIds: string[] = [];
  let maxSources = Number(process.env.SUWAYOMI_MAX_SOURCES || 10);
  // 「政策是否可信」與「政策是否為空」必須分開：
  // 空的 SourceIds 代表管理員刻意不限制，而讀取失敗代表我們不知道限制是什麼。
  // 後者若當成前者，授權就 fail open（等於解除包含 NSFW 屏蔽的所有限制）。
  let policyKnown = false;

  try {
    const config = await getConfig();
    // 綁在「這一份設定物件」上，不讀全域旗標：後者與這行是兩個敘述，
    // 中間別的請求完成一次成功載入就會把旗標翻成 false，
    // 於是我們會用降級設定（SourceIds 空＝不限制）卻認為政策已知 → fail open。
    policyKnown = !isDegradedConfigObject(config);
    if (config.SuwayomiConfig?.Enabled) {
      serverUrl = config.SuwayomiConfig.ServerURL || serverUrl;
      authMode = normalizeSuwayomiAuthMode(config.SuwayomiConfig.AuthMode || authMode);
      username = config.SuwayomiConfig.Username || username;
      password = config.SuwayomiConfig.Password || password;
      defaultLang = config.SuwayomiConfig.DefaultLang || defaultLang;
      sourceIds = config.SuwayomiConfig.SourceIds || sourceIds;
      maxSources = config.SuwayomiConfig.MaxSources || maxSources;
    }
  } catch {
    // 配置读取失败时回退到环境变量；policyKnown 保持 false
  }

  if (options.serverUrl !== undefined) {
    serverUrl = options.serverUrl;
  }
  if (options.authMode !== undefined) {
    authMode = normalizeSuwayomiAuthMode(options.authMode);
  }
  if (options.username !== undefined) {
    username = options.username;
  }
  if (options.password !== undefined) {
    password = options.password;
  }

  if (!serverUrl) {
    throw new Error('Suwayomi 未配置，请先在管理面板或环境变量中设置服务地址');
  }

  const normalizedBaseUrl = normalizeApiBaseUrl(serverUrl);

  return {
    serverBaseUrl: normalizedBaseUrl,
    serverUrl: normalizedBaseUrl + '/api/graphql',
    authMode,
    username: username || undefined,
    password: password || undefined,
    defaultLang,
    sourceIds,
    maxSources,
    policyKnown,
  };
}

export async function getSuwayomiConfig(options: SuwayomiClientOptions = {}): Promise<ResolvedSuwayomiConfig> {
  return resolveSuwayomiConfig(options);
}

export function buildSuwayomiImageProxyUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  if (pathOrUrl.startsWith('/api/manga/image?')) return pathOrUrl;
  return `/api/manga/image?path=${encodeURIComponent(pathOrUrl)}`;
}

async function getSuwayomiRequestHeaders(
  resolved: ResolvedSuwayomiConfig,
  forceSimpleLoginRefresh = false
): Promise<HeadersInit | undefined> {
  if (resolved.authMode === 'basic_auth') {
    if (!resolved.username || !resolved.password) {
      throw new Error('Suwayomi basic_auth 缺少用户名或密码');
    }

    return {
      Authorization: buildBasicAuthHeader(resolved.username, resolved.password),
    };
  }

  if (resolved.authMode === 'simple_login') {
    return {
      Cookie: await loginWithSimpleAuth(resolved, forceSimpleLoginRefresh),
    };
  }

  return undefined;
}

async function suwayomiFetch(
  resolved: ResolvedSuwayomiConfig,
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const timeoutMs = DEFAULT_SUWAYOMI_TIMEOUT_MS;

  const execute = async (forceSimpleLoginRefresh: boolean) => {
    const authHeaders = await getSuwayomiRequestHeaders(resolved, forceSimpleLoginRefresh);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error(`Suwayomi 请求超时(${timeoutMs}ms)`)), timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        headers: {
          ...(authHeaders || {}),
          ...(init.headers || {}),
        },
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let response = await execute(false);
  if (response.status === 401 && resolved.authMode === 'simple_login') {
    response = await execute(true);
  }

  return response;
}

function normalizeMangaStatus(status?: string): string | undefined {
  if (!status) return undefined;

  const normalized = status.trim().toUpperCase();
  switch (normalized) {
    case 'ONGOING':
      return '连载中';
    case 'COMPLETED':
      return '已完结';
    case 'LICENSED':
      return '已授权';
    case 'PUBLISHING_FINISHED':
      return '已完结';
    case 'CANCELLED':
      return '已取消';
    case 'ON_HIATUS':
      return '休刊中';
    case 'UNKNOWN':
    case 'UNRECOGNIZED':
      return undefined;
    default:
      return status;
  }
}

export class SuwayomiClient {
  private options: SuwayomiClientOptions;
  private sourcesHaveContentWarning = new Map<string, boolean>();
  /**
   * `manga(id:)` / `chapter(id:)` 的 id 型別在不同 Suwayomi 版本不一致
   * （實測 v2.3 是 `Int!`，較舊／較新版本有 `LongString!`）。
   * 記住哪一種可用，避免每次都先失敗一次。
   */
  private nodeIdGraphqlType = new Map<string, 'Int!' | 'LongString!'>();
  /**
   * `getSources()` 與 mangaId→sourceId 的短期快取。
   *
   * 白名單檢查現在落在每張封面／每頁內頁的授權路徑上（image proxy），
   * 沒有快取的話一個 96 張封面的列表會產生約 192 次上游 GraphQL，
   * 而且全都擋在圖片位元組前面。授權語意不變，只是不要每張圖重算。
   * TTL 短到管理員改 SourceIds 後很快生效。
   */
  private static readonly SOURCES_TTL_MS = 30_000;
  private static readonly MANGA_SOURCE_TTL_MS = 300_000;
  /**
   * 容量上限：這兩個 Map 的 key 都含外部可影響的成分（lang、mangaId），
   * 沒有上限的話可以被迴圈打成無界記憶體成長。以插入序做 LRU 汰除。
   */
  private static readonly SOURCES_CACHE_MAX = 32;
  private static readonly MANGA_SOURCE_CACHE_MAX = 4096;
  private sourcesCache = new Map<
    string,
    { at: number; inflight?: Promise<MangaSource[]>; value?: MangaSource[] }
  >();
  private mangaSourceCache = new Map<string, { at: number; sourceId: string }>();

  /** Map 以插入序疊代，重設 key 前先 delete 即可把它移到尾端 */
  private static capMap(map: Map<string, unknown>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  constructor(options: SuwayomiClientOptions = {}) {
    this.options = options;
  }

  private async graphqlRequest<T>(
    query: string,
    variables?: Record<string, any>,
    operationName?: string,
    resolvedConfig?: ResolvedSuwayomiConfig
  ): Promise<T> {
    const resolved =
      resolvedConfig ?? (await resolveSuwayomiConfig(this.options));
    const response = await suwayomiFetch(resolved, resolved.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables, operationName }),
    });

    if (!response.ok) {
      throw new Error(`Suwayomi 请求失败: ${response.status}`);
    }

    const data = (await response.json()) as GraphQLResponse<T>;
    if (data.errors?.length) {
      throw new Error(data.errors.map((item) => item.message || 'Unknown error').join('; '));
    }
    if (!data.data) {
      throw new Error('Suwayomi 返回空数据');
    }
    return data.data;
  }

  /**
   * 帶短期快取與 in-flight 合併的來源清單。
   *
   * 授權路徑（assertSourceAllowed）每次呼叫都會用到，圖片代理更是每張圖一次；
   * 未快取時同一次頁面載入會重複打十幾次上游。同一個 key 的併發請求
   * 也合併成一次，避免 legacy schema fallback 被並發各觸發一輪。
   */
  async getSources(lang?: string): Promise<MangaSource[]> {
    const resolved = await resolveSuwayomiConfig(this.options);
    // 政策不可信時絕不回來源清單：降級設定的 sourceIds 是空陣列，
    // 而空陣列在下面等於「不限制」，會把全部來源（含已停用的）交出去。
    // 在這裡擋掉，呼叫端（assertSourceAllowed 等）就不可能拿到未過濾清單。
    if (!resolved.policyKnown) {
      throw new MangaSourceForbiddenError(
        '无法读取来源限制设置，已暂时拒绝访问'
      );
    }
    // 政策必須進 key：快取值已套用當時的 SourceIds，若 key 只有 server/lang，
    // 管理員停用來源後最長 TTL 內仍會回舊清單，等於用 TTL 延後授權撤銷。
    // 政策一變 key 就變 → 立即 miss → 重新以當前政策抓取。
    const policy = [...resolved.sourceIds].sort().join(',');
    // lang 不可正規化成 defaultLang：fetchSources 只在 lang 有值時過濾，
    // 若把 undefined 併入 'zh' 的 key，未過濾的完整清單會被當成 zh 清單回出去
    // （反向則會讓 assertSourceAllowed 誤拒合法的非 zh 來源）。
    const langKey = lang === undefined ? '*' : lang;
    const key = `${resolved.serverBaseUrl}::${langKey}::${policy}`;
    const now = Date.now();
    const hit = this.sourcesCache.get(key);

    if (hit) {
      if (hit.inflight) return hit.inflight;
      if (hit.value && now - hit.at < SuwayomiClient.SOURCES_TTL_MS) {
        return hit.value;
      }
    }

    // fetchSources 必須吃「建 key 用的同一份 snapshot」：
    // 若讓它自己再 resolve 一次，兩次 resolve 之間政策若改變，
    // 較寬政策過濾出的清單會被寫進較窄政策的 key，形成撤銷繞過窗口。
    const inflight = this.fetchSources(lang, resolved)
      .then((value) => {
        // compare-and-set：容量汰除或後續呼叫可能已讓這個 key 指向別的
        // inflight，較舊的 promise 不可覆寫較新的結果
        if (this.sourcesCache.get(key)?.inflight === inflight) {
          this.sourcesCache.delete(key);
          this.sourcesCache.set(key, { at: Date.now(), value });
          SuwayomiClient.capMap(this.sourcesCache, SuwayomiClient.SOURCES_CACHE_MAX);
        }
        return value;
      })
      .catch((error) => {
        // 失敗不留快取，下次重新嘗試；同樣只清掉自己那一筆
        if (this.sourcesCache.get(key)?.inflight === inflight) {
          this.sourcesCache.delete(key);
        }
        throw error;
      });

    this.sourcesCache.set(key, { at: now, inflight });
    SuwayomiClient.capMap(this.sourcesCache, SuwayomiClient.SOURCES_CACHE_MAX);
    return inflight;
  }

  /**
   * 列出「全部」來源，不套 admin 允許清單。
   *
   * 管理面板必須看得到已停用的來源才能把它重新啟用；
   * `getSources()` 會套允許清單，被停用的來源在那裡是看不到的。
   * 僅限管理員路徑呼叫；一般使用者入口一律用 `getSources()`。
   * 不進 sourcesCache：避免未過濾的清單被授權路徑讀到。
   */
  async getSourcesForAdmin(lang?: string): Promise<MangaSource[]> {
    return this.fetchSources(lang, undefined, true);
  }

  private async fetchSources(
    lang?: string,
    snapshot?: ResolvedSuwayomiConfig,
    /** true = 不套 admin 允許清單（僅供管理面板列出全部來源） */
    unscoped = false
  ): Promise<MangaSource[]> {
    const resolved = snapshot ?? (await resolveSuwayomiConfig(this.options));
    const sourceSelection = `
            id
            name
            lang
            displayName
            contentWarning
    `;
    const legacySelection = `
            id
            name
            lang
            displayName
    `;
    const buildQuery = (fields: string) => `
      query GetSources {
        sources {
          nodes {
${fields}
          }
        }
      }
    `;

    type SourceNode = {
      id: string;
      name?: string;
      lang?: string;
      displayName?: string;
      contentWarning?: string;
    };

    let nodes: SourceNode[] = [];
    const warningCapability = this.sourcesHaveContentWarning.get(
      resolved.serverBaseUrl
    );
    if (warningCapability === false) {
      const data = await this.graphqlRequest<{
        sources?: { nodes?: SourceNode[] };
      }>(buildQuery(legacySelection), undefined, undefined, resolved);
      nodes = data.sources?.nodes || [];
    } else {
      try {
        const data = await this.graphqlRequest<{
          sources?: { nodes?: SourceNode[] };
        }>(buildQuery(sourceSelection), undefined, undefined, resolved);
        nodes = data.sources?.nodes || [];
        this.sourcesHaveContentWarning.set(resolved.serverBaseUrl, true);
      } catch (error) {
        if (!isSuwayomiUnknownFieldError(error)) {
          throw error;
        }
        this.sourcesHaveContentWarning.set(resolved.serverBaseUrl, false);
        const data = await this.graphqlRequest<{
          sources?: { nodes?: SourceNode[] };
        }>(buildQuery(legacySelection), undefined, undefined, resolved);
        nodes = data.sources?.nodes || [];
      }
    }

    const filtered = nodes.filter((item) => !lang || item.lang === lang);
    const scoped =
      !unscoped && resolved.sourceIds.length > 0
        ? filtered.filter((item) => resolved.sourceIds.includes(String(item.id)))
        : filtered;

    return scoped.map((item) => ({
      id: String(item.id),
      name: item.name || item.displayName || String(item.id),
      lang: item.lang,
      displayName: item.displayName,
      contentWarning:
        item.contentWarning === 'SAFE' ||
        item.contentWarning === 'MIXED' ||
        item.contentWarning === 'NSFW'
          ? item.contentWarning
          : undefined,
    }));
  }

  async getSearchSources(
    sourceId?: string | string[]
  ): Promise<Array<{ id: string; displayName?: string; name?: string }>> {
    const resolved = await resolveSuwayomiConfig(this.options);
    // 這條路不走 assertSourceAllowed（它自己比對 getSources()），
    // 所以 policyKnown 必須在這裡單獨擋一次。降級設定下 sourceIds 是空陣列，
    // getSources() 會回傳全部來源，搜尋就會 fail open。
    if (!resolved.policyKnown) {
      throw new MangaSourceForbiddenError(
        '无法读取来源限制设置，已暂时拒绝访问'
      );
    }
    const requested = (Array.isArray(sourceId) ? sourceId : sourceId ? [sourceId] : [])
      .map((id) => id.trim())
      .filter(Boolean);

    if (requested.length > 0) {
      // getSources() 已套用 admin 的 SourceIds 允許清單；
      // 不在清單內的 id 一律丟掉，避免用 URL 直接繞過管理員限制。
      const known = await this.getSources();
      const byId = new Map(known.map((item) => [item.id, item]));
      const allowed = requested.filter((id) => byId.has(id));

      if (allowed.length === 0) {
        throw new MangaSourceForbiddenError();
      }

      return allowed.slice(0, resolved.maxSources).map((id) => {
        const matched = byId.get(id);
        return {
          id,
          displayName: matched?.displayName || matched?.name || id,
          name: matched?.name || matched?.displayName || id,
        };
      });
    }

    try {
      return (await this.getSources(resolved.defaultLang)).slice(0, resolved.maxSources);
    } catch (error) {
      if (resolved.sourceIds.length === 0) {
        throw error;
      }
      return resolved.sourceIds.slice(0, resolved.maxSources).map((id) => ({
        id,
        displayName: id,
        name: id,
      }));
    }
  }

  async searchMangaSource(
    keyword: string,
    source: { id: string; displayName?: string; name?: string },
    page = 1
  ): Promise<{ source: { id: string; displayName?: string; name?: string }; results: MangaSearchItem[] }> {
    const query = `
      mutation GET_SOURCE_MANGAS_FETCH($input: FetchSourceMangaInput!) {
        fetchSourceManga(input: $input) {
          mangas {
            id
            title
            thumbnailUrl
            sourceId
            description
            author
            artist
            genre
            status
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      fetchSourceManga?: {
        mangas?: Array<{
          id: string | number;
          title?: string;
          thumbnailUrl?: string;
          sourceId?: string | number;
          description?: string;
          author?: string;
          artist?: string;
          genre?: string;
          status?: string;
        }>;
      };
    }>(
      query,
      {
        input: {
          type: 'SEARCH',
          source: source.id,
          query: keyword,
          page,
        },
      },
      'GET_SOURCE_MANGAS_FETCH'
    );

    const seen = new Set<string>();
    const sourceName = source.displayName || source.name || String(source.id);
    const results = (data.fetchSourceManga?.mangas || [])
      .filter((manga) => {
        const key = `${source.id}:${manga.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((manga) => ({
        id: String(manga.id),
        sourceId: String(manga.sourceId || source.id),
        sourceName,
        title: manga.title || '未命名漫画',
        cover: buildSuwayomiImageProxyUrl(manga.thumbnailUrl || ''),
        description: manga.description,
        author: manga.author,
        artist: manga.artist,
        genre: manga.genre,
        status: normalizeMangaStatus(manga.status),
      }));

    return { source, results };
  }

  async searchManga(
    keyword: string,
    sourceId?: string | string[],
    page = 1
  ): Promise<MangaSearchResult> {
    const sources = await this.getSearchSources(sourceId);
    const results: MangaSearchItem[] = [];
    const failedSources: MangaSearchFailure[] = [];
    const measurements: MangaSourceMeasurement[] = [];
    const seen = new Set<string>();

    const perSourceResults = await Promise.all(
      sources.map(async (source) => {
        const startedAt = Date.now();
        try {
          const result = await this.searchMangaSource(keyword, source, page);
          measurements.push({
            sourceId: String(source.id),
            elapsedMs: Date.now() - startedAt,
            failed: false,
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : '未知错误';
          console.warn(`[Suwayomi] manga search source failed: ${source.id} - ${message}`);
          failedSources.push({
            sourceId: String(source.id),
            sourceName: source.displayName || source.name || String(source.id),
            error: message,
          });
          measurements.push({
            sourceId: String(source.id),
            elapsedMs: Date.now() - startedAt,
            failed: true,
          });
          return {
            source,
            results: [],
          };
        }
      })
    );

    for (const { results: sourceResults } of perSourceResults) {
      for (const manga of sourceResults) {
        const key = `${manga.sourceId}:${manga.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(manga);
      }
    }

    return {
      results,
      failedSources,
      attemptedSources: sources.length,
      measurements,
    };
  }

  /**
   * 政策（admin SourceIds）是否可信；不可信就拒絕。
   *
   * 刻意不放在 getSources() 裡：那個方法也是 /api/admin/suwayomi 連線測試
   * 用的（帶明確 options、不依賴儲存的政策），在設定故障時把它一起擋掉，
   * 等於讓管理員在最需要診斷的時候無法測連線。
   * 因此檢查放在「授權邊界」與「面向使用者的列表端點」。
   */
  async assertPolicyKnown(): Promise<void> {
    const resolved = await resolveSuwayomiConfig(this.options);
    if (!resolved.policyKnown) {
      throw new MangaSourceForbiddenError(
        '无法读取来源限制设置，已暂时拒绝访问'
      );
    }
  }

  /**
   * 確認 sourceId 在 admin 的允許清單內（getSources 已套用 SourceIds）。
   * 所有以 sourceId 對外發請求的入口都要先過這道，否則使用者可用 URL 繞過管理員限制。
   */
  private async assertSourceAllowed(
    sourceId: string
  ): Promise<MangaSource | undefined> {
    // getSources() 自己會在政策不可信時丟 MangaSourceForbiddenError，
    // 所以這裡不需要（也不該）再讀一次全域旗標——那會有 TOCTOU。
    const known = await this.getSources();
    const matched = known.find((item) => item.id === sourceId);
    if (!matched) {
      throw new MangaSourceForbiddenError();
    }
    return matched;
  }

  /**
   * 讀取某來源自帶的 select/sort filters。
   * Suwayomi 沒有跨來源的「日/週/月排行」API，排行只存在於個別來源的 filter 裡；
   * 沒有 filters 的來源會回空陣列，呼叫端應隱藏分類 UI。
   */
  async getSourceFilters(sourceId: string): Promise<MangaSourceFilterOption[]> {
    if (!sourceId) return [];
    await this.assertSourceAllowed(sourceId);

    const query = `
      query GetSourceFilters($id: LongString!) {
        source(id: $id) {
          id
          filters {
            __typename
            ... on SelectFilter { name values }
            ... on SortFilter { name values }
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      source?: {
        filters?: Array<{
          __typename?: string;
          name?: string;
          values?: string[];
        }>;
      };
    }>(query, { id: sourceId }, 'GetSourceFilters');

    const raw = data.source?.filters || [];
    const options: MangaSourceFilterOption[] = [];
    raw.forEach((filter, position) => {
      const kind =
        filter.__typename === 'SelectFilter'
          ? 'select'
          : filter.__typename === 'SortFilter'
            ? 'sort'
            : null;
      if (!kind) return;
      const values = (filter.values || []).filter(
        (v): v is string => typeof v === 'string'
      );
      if (values.length === 0 || !filter.name) return;
      options.push({ position, kind, name: filter.name, values });
    });
    return options;
  }

  /**
   * 主動探測單一來源：實際抓一次 POPULAR 第一頁並計時。
   *
   * **刻意不套 assertSourceAllowed**：管理面板需要能測「目前被停用」的來源，
   * 才能判斷要不要啟用它。因此呼叫端必須是管理員專用路徑
   * （`/api/admin/manga-sources`），一般使用者入口不可呼叫這個方法。
   *
   * 這是管理員明確按下按鈕才觸發的診斷動作，不是背景自動輪詢 ——
   * 自動對所有來源發請求等於替使用者去打漫畫站。
   */
  async probeSource(
    sourceId: string
  ): Promise<{ ok: boolean; elapsedMs: number; count: number; error?: string }> {
    const startedAt = Date.now();
    try {
      const query = `
        mutation PROBE_SOURCE($input: FetchSourceMangaInput!) {
          fetchSourceManga(input: $input) {
            hasNextPage
            mangas { id }
          }
        }
      `;
      const data = await this.graphqlRequest<{
        fetchSourceManga?: { mangas?: Array<{ id: string | number }> };
      }>(
        query,
        { input: { source: sourceId, type: 'POPULAR', page: 1 } },
        'PROBE_SOURCE'
      );
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        count: (data.fetchSourceManga?.mangas || []).length,
      };
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        count: 0,
        error: error instanceof Error ? error.message : '未知错误',
      };
    }
  }

  async getRecommendedManga(
    sourceId: string,
    type: MangaRecommendType = 'POPULAR',
    page = 1,
    filters: MangaFilterSelection[] = []
  ): Promise<MangaRecommendResult> {
    if (!sourceId) {
      return { mangas: [], hasNextPage: false };
    }

    const query = `
      fragment MANGA_BASE_FIELDS on MangaType {
        id
        title
        thumbnailUrl
        sourceId
        description
        author
        artist
        genre
        status
      }

      mutation GET_SOURCE_MANGAS_FETCH($input: FetchSourceMangaInput!) {
        fetchSourceManga(input: $input) {
          hasNextPage
          mangas {
            ...MANGA_BASE_FIELDS
          }
        }
      }
    `;

    const matchedSource = await this.assertSourceAllowed(sourceId);

    const data = await this.graphqlRequest<{
      fetchSourceManga?: {
        hasNextPage?: boolean;
        mangas?: Array<{
          id: string | number;
          title?: string;
          thumbnailUrl?: string;
          sourceId?: string | number;
          description?: string;
          author?: string;
          artist?: string;
          genre?: string;
          status?: string;
        }>;
      };
    }>(
      query,
      {
        input:
          filters.length > 0
            ? {
                // Suwayomi 只在 SEARCH 模式套用 filters；POPULAR/LATEST 會忽略。
                // 空 query + filters = 以該來源自己的分類／排序瀏覽。
                type: 'SEARCH',
                source: sourceId,
                page,
                query: '',
                filters: filters.map((selection) =>
                  selection.kind === 'sort'
                    ? {
                        position: selection.position,
                        sortState: {
                          index: selection.index,
                          ascending: selection.ascending ?? false,
                        },
                      }
                    : {
                        position: selection.position,
                        selectState: selection.index,
                      }
                ),
              }
            : {
                type,
                source: sourceId,
                page,
              },
      },
      'GET_SOURCE_MANGAS_FETCH'
    );

    return {
      hasNextPage: Boolean(data.fetchSourceManga?.hasNextPage),
      mangas: (data.fetchSourceManga?.mangas || []).map((manga) => ({
        id: String(manga.id),
        sourceId: String(manga.sourceId || sourceId),
        sourceName: matchedSource?.displayName || matchedSource?.name || sourceId,
        title: manga.title || '未命名漫画',
        cover: buildSuwayomiImageProxyUrl(manga.thumbnailUrl || ''),
        description: manga.description,
        author: manga.author,
        artist: manga.artist,
        genre: manga.genre,
        status: normalizeMangaStatus(manga.status),
      })),
    };
  }

  async getChapters(mangaId: string): Promise<MangaChapter[]> {
    const mutation = `
      mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
        fetchChapters(input: $input) {
          chapters {
            id
            mangaId
            name
            chapterNumber
            scanlator
            isRead
            isDownloaded
            pageCount
            uploadDate
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      fetchChapters?: {
        chapters?: Array<{
          id: string | number;
          mangaId?: string | number;
          name?: string;
          chapterNumber?: number;
          scanlator?: string;
          isRead?: boolean;
          isDownloaded?: boolean;
          pageCount?: number;
          uploadDate?: number;
        }>;
      };
    }>(mutation, { input: { mangaId: Number(mangaId) || mangaId } }, 'GET_MANGA_CHAPTERS_FETCH');

    return (data.fetchChapters?.chapters || []).map((chapter) => ({
      id: String(chapter.id),
      mangaId: String(chapter.mangaId || mangaId),
      name: chapter.name || '未命名章节',
      chapterNumber: chapter.chapterNumber,
      scanlator: chapter.scanlator,
      isRead: chapter.isRead,
      isDownloaded: chapter.isDownloaded,
      pageCount: chapter.pageCount,
      uploadDate: chapter.uploadDate,
    }));
  }

  /**
   * 用伺服器接受的 id 型別跑一次 node 查詢。
   *
   * 舊實作把 `LongString!` 寫死並用 try/catch 吞掉錯誤，導致在只接受
   * `Int!` 的伺服器上這個查詢「一直失敗、靜默退回客戶端參數」。授權要用
   * 這個結果，所以型別必須真的談成，不能靠吞錯誤蓋過去。
   */
  private async graphqlNodeQuery<T>(
    buildQuery: (idType: 'Int!' | 'LongString!') => string,
    id: string,
    operationName: string
  ): Promise<{ data: T; resolved: ResolvedSuwayomiConfig }> {
    const resolved = await resolveSuwayomiConfig(this.options);
    // key 必須含 operationName：`manga(id:)` 與 `chapter(id:)` 在同一版本上
    // 可能是不同型別，共用 key 會讓其中一邊被另一邊的結果汙染。
    const cacheKey = `${resolved.serverBaseUrl}::${operationName}`;
    const cached = this.nodeIdGraphqlType.get(cacheKey);
    const asInt = Number(id);
    const candidates: Array<'Int!' | 'LongString!'> = Number.isFinite(asInt)
      ? ['Int!', 'LongString!']
      : ['LongString!'];
    // 命中快取只調整「先試哪個」，不可縮成單一選項，
    // 否則快取一旦失準（伺服器升級、key 判斷失誤）就再也走不到 fallback。
    const order = cached
      ? [cached, ...candidates.filter((item) => item !== cached)]
      : candidates;

    let lastError: unknown;
    for (const idType of order) {
      try {
        const data = await this.graphqlRequest<T>(
          buildQuery(idType),
          { id: idType === 'Int!' ? asInt : id },
          operationName,
          resolved
        );
        this.nodeIdGraphqlType.set(cacheKey, idType);
        return { data, resolved };
      } catch (error) {
        lastError = error;
        // 只有型別不合才換另一種再試；其他錯誤（連線、權限）直接往上丟
        if (!/VariableTypeMismatch|of type .* used in position/i.test(
          error instanceof Error ? error.message : String(error)
        )) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /**
   * 從伺服器查出 manga 真正所屬的 sourceId。
   *
   * 授權判斷絕不能信客戶端傳來的 sourceId：攻擊者只要拿「允許來源的 id」
   * 配上「被停用來源的 mangaId」就能繞過。這裡回傳的是伺服器的事實。
   */
  private async resolveMangaSource(mangaId: string): Promise<{
    sourceId: string;
    manga?: {
      id: string | number;
      title?: string;
      thumbnailUrl?: string;
      sourceId?: string | number;
      description?: string;
      author?: string;
      artist?: string;
      genre?: string;
      status?: string;
    };
  }> {
    const { data, resolved: snapshot } = await this.graphqlNodeQuery<{
      manga?: {
        id: string | number;
        title?: string;
        thumbnailUrl?: string;
        sourceId?: string | number;
        description?: string;
        author?: string;
        artist?: string;
        genre?: string;
        status?: string;
      };
    }>(
      (idType) => `
      query MangaDetail($id: ${idType}) {
        manga(id: $id) {
          id
          title
          thumbnailUrl
          sourceId
          description
          author
          artist
          genre
          status
        }
      }
    `,
      mangaId,
      'MangaDetail'
    );

    const resolved = data.manga?.sourceId;
    if (!resolved) {
      // 查不到歸屬就無法判斷是否被停用 —— 授權路徑必須 fail closed，
      // 不可退回客戶端提供的 sourceId。
      throw new MangaSourceForbiddenError('无法确认该漫画的来源，已拒绝访问');
    }

    const sourceId = String(resolved);
    // key 必須用「發出這次查詢的那份 snapshot」的 serverBaseUrl。
    // 若在這裡重新 resolve，查詢期間管理員換了 Suwayomi 伺服器的話，
    // 舊伺服器的來源歸屬會被寫進新伺服器的 namespace，造成跨來源授權繞過。
    const mangaKey = `${snapshot.serverBaseUrl}::${mangaId}`;
    this.mangaSourceCache.delete(mangaKey);
    this.mangaSourceCache.set(mangaKey, {
      at: Date.now(),
      sourceId,
    });
    SuwayomiClient.capMap(
      this.mangaSourceCache,
      SuwayomiClient.MANGA_SOURCE_CACHE_MAX
    );
    return { sourceId, manga: data.manga };
  }

  /**
   * 以 mangaId 驗證來源白名單（供圖片代理這類只有 mangaId 的入口使用）。
   * 來源一律由伺服器解析，不接受呼叫端傳入。
   */
  async assertMangaAllowed(mangaId: string): Promise<void> {
    const resolved = await resolveSuwayomiConfig(this.options);
    // 政策未知時要在「送出任何上游請求之前」就拒絕。若先 resolveMangaSource
    // 再擋，等於讓使用者在授權不明的狀態下驅動任意 manga(id:) 查詢。
    if (!resolved.policyKnown) {
      throw new MangaSourceForbiddenError(
        '无法读取来源限制设置，已暂时拒绝访问'
      );
    }
    const cached = this.mangaSourceCache.get(
      `${resolved.serverBaseUrl}::${mangaId}`
    );
    const sourceId =
      cached && Date.now() - cached.at < SuwayomiClient.MANGA_SOURCE_TTL_MS
        ? cached.sourceId
        : (await this.resolveMangaSource(mangaId)).sourceId;
    // assertSourceAllowed 仍然每次都跑：它讀的是（已快取的）來源清單，
    // 管理員改 SourceIds 後會在 SOURCES_TTL_MS 內生效。
    await this.assertSourceAllowed(sourceId);
  }

  async getMangaDetail(input: {
    mangaId: string;
    sourceId: string;
    title?: string;
    cover?: string;
    sourceName?: string;
    description?: string;
    author?: string;
    status?: string;
  }): Promise<MangaDetail> {
    // 政策未知要在送出任何上游請求之前擋掉，否則使用者仍能在授權不明時
    // 驅動一次 manga(id:) 查詢。
    await this.assertPolicyKnown();
    // 先驗權再取內容：getChapters 也會外發請求，順序顛倒等於先洩漏再檢查。
    const { sourceId: trueSourceId, manga } = await this.resolveMangaSource(
      input.mangaId
    );
    await this.assertSourceAllowed(trueSourceId);

    const chapters = await this.getChapters(input.mangaId);

    return {
      id: manga ? String(manga.id) : input.mangaId,
      sourceId: trueSourceId,
      sourceName: input.sourceName || trueSourceId,
      title: manga?.title || input.title || '漫画详情',
      cover: buildSuwayomiImageProxyUrl(manga?.thumbnailUrl || input.cover || ''),
      description: manga?.description || input.description,
      author: manga?.author || input.author,
      artist: manga?.artist,
      genre: manga?.genre,
      status: normalizeMangaStatus(manga?.status || input.status),
      chapters,
    };
  }

  async getChapterPages(chapterId: string): Promise<string[]> {
    // 政策未知要在送出任何上游請求之前擋掉（含下面的 ChapterSource 反查）
    await this.assertPolicyKnown();
    // chapterId 不帶來源資訊，先反查 chapter -> manga -> sourceId 再驗權，
    // 否則被停用來源的內容仍可用 chapterId 直接讀出。
    const { data: chapterData } = await this.graphqlNodeQuery<{
      chapter?: { manga?: { sourceId?: string | number } };
    }>(
      (idType) => `
      query ChapterSource($id: ${idType}) {
        chapter(id: $id) {
          id
          manga {
            id
            sourceId
          }
        }
      }
    `,
      chapterId,
      'ChapterSource'
    );

    const chapterSourceId = chapterData.chapter?.manga?.sourceId;
    if (!chapterSourceId) {
      throw new MangaSourceForbiddenError('无法确认该章节的来源，已拒绝访问');
    }
    await this.assertSourceAllowed(String(chapterSourceId));

    const mutation = `
      mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
        fetchChapterPages(input: $input) {
          pages
        }
      }
    `;

    const data = await this.graphqlRequest<{
      fetchChapterPages?: { pages?: string[] };
    }>(mutation, { input: { chapterId: Number(chapterId) || chapterId } }, 'GET_CHAPTER_PAGES_FETCH');

    return (data.fetchChapterPages?.pages || []).map((item) => buildSuwayomiImageProxyUrl(item));
  }
}

export const suwayomiClient = new SuwayomiClient();
