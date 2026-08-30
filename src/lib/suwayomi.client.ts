/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'crypto';

import { getConfig, isDegradedConfigObject } from './config';
import {
  buildFilterChangeInputs,
  isMangaSourceAllowed,
  MANGA_DISABLE_ALL_SENTINEL,
  matchesSourceLang,
  MangaChapter,
  MangaDetail,
  MangaFilterSelection,
  MangaRecommendResult,
  MangaSearchFailure,
  MangaRecommendType,
  MangaSearchItem,
  MangaSearchResult,
  MangaSearchSourceRef,
  MangaSource,
  MangaSourceFilterOption,
  MangaSourceMeasurement,
  MangaSourceProbe,
  MangaSourceProbeOutcome,
  MangaSourceSearchOutcome,
  MangaSourceSearchResponse,
  SourceExternalUrl,
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
  /** 明確停用的來源（黑名單）；與 sourceIds 是 AND 關係 */
  disabledSourceIds: string[];
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
/**
 * `setTimeout` 能表示的最大延遲。
 *
 * 超過 32-bit signed integer 時 Node 會發出 overflow 警告並把延遲壓成約 1ms ——
 * 也就是「想把 deadline 放寬」的設定會變成「幾乎立刻逾時」，方向完全相反。
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * 解析毫秒設定值，無效就退回預設。
 *
 * 不能直接 `Number(env || fallback)`：把 `MANGA_SEARCH_SOURCE_TIMEOUT_MS`
 * 寫成 `3s` 會得到 NaN，而 `setTimeout(fn, NaN)` 依規範等同延遲 0 ——
 * 於是每顆來源在第一個 macrotask 就逾時，整站搜尋靜默全滅，
 * 唯一線索是錯誤訊息裡的 `NaN`。
 *
 * 要擋的無效值：NaN、0、負數、Infinity，以及超過 `MAX_TIMEOUT_MS`
 * 的過大值（後者同樣會變成約 1ms）。
 */
function resolveTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    console.warn(
      `[Suwayomi] 忽略無效的超時設定 ${JSON.stringify(raw)}，改用 ${fallback}ms`
    );
    return fallback;
  }
  return parsed;
}

const DEFAULT_SUWAYOMI_TIMEOUT_MS = resolveTimeoutMs(
  process.env.SUWAYOMI_TIMEOUT_MS,
  20000
);

/**
 * 單一來源的搜尋上限。
 *
 * 搜尋是 fan-out：`searchManga` 用 Promise.all 同時打所有來源，整體耗時等於
 * 最慢那顆。共用的 20 秒 deadline 對閱讀內頁是合理的，對搜尋卻代表一顆卡住的
 * 來源就能讓整頁結果停 20 秒。
 *
 * 3 秒的餘裕並不寬：實測 10 顆併發時最慢的**合法**來源要 1880ms，另外記錄過
 * 8.3s 的離群值。網路較差時可能把本來會成功的來源切掉，屆時用
 * `MANGA_SEARCH_SOURCE_TIMEOUT_MS` 調大即可（SSE 會逐顆先送結果，
 * 調大只影響 spinner 何時停，不影響已回來的來源何時顯示）。
 *
 * 逾時的來源會進 failedSources 並帶 `timedOut`，健康度不會把它當成「失效」。
 */
export const PER_SOURCE_SEARCH_TIMEOUT_MS = resolveTimeoutMs(
  process.env.MANGA_SEARCH_SOURCE_TIMEOUT_MS,
  3000
);

/**
 * 探測搜尋能力時用的關鍵詞。
 *
 * 必須是繁簡都常見的單字，否則「搜不到結果」與「搜尋壞掉」會分不清 ——
 * 探測只在意「呼叫有沒有成功」，不在意筆數，但用太罕見的詞會讓正常來源
 * 回 0 筆而顯得可疑。
 */
const PROBE_SEARCH_KEYWORD = '龍';

/** fan-out 逾時的哨兵，用來和來源正常回傳的結果區分。 */
interface SearchDeadlineSentinel {
  readonly deadlineReached: true;
}

const SEARCH_DEADLINE: SearchDeadlineSentinel = { deadlineReached: true };

const suwayomiSessionCache = new Map<string, SuwayomiSessionCacheEntry>();
/**
 * 已警告過的「無法渲染的 filter」清單，用來去重。
 *
 * `getSourceFilters` 刻意沒有快取（管理員在 Suwayomi 改了 filter 設定要能
 * 立即生效），而 UI 每次切換來源都會重打一次，同一顆來源的同一份清單
 * 印一次就夠。key 含內容，來源升級後清單變了仍會再提醒一次。
 */
const warnedDroppedFilters = new Set<string>();

function normalizeSuwayomiAuthMode(
  value?: string | null
): 'none' | 'basic_auth' | 'simple_login' {
  if (value === 'basic_auth' || value === 'simple_login') {
    return value;
  }
  return 'none';
}

function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function hashSimpleLoginPassword(password?: string): string {
  return createHash('sha256')
    .update(password || '')
    .digest('hex');
}

function getSimpleLoginCacheKey(config: ResolvedSuwayomiConfig): string {
  return `${config.serverBaseUrl}|${
    config.username || ''
  }|${hashSimpleLoginPassword(config.password)}`;
}

function getResponseSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
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
    `${config.serverBaseUrl}/login.html?redirect=${encodeURIComponent(
      '/api/graphql'
    )}`,
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

async function resolveSuwayomiConfig(
  options: SuwayomiClientOptions = {}
): Promise<ResolvedSuwayomiConfig> {
  let serverUrl =
    process.env.SUWAYOMI_URL || process.env.NEXT_PUBLIC_SUWAYOMI_URL || '';
  let authMode = normalizeSuwayomiAuthMode(process.env.SUWAYOMI_AUTH_MODE);
  let username = process.env.SUWAYOMI_USERNAME || '';
  let password = process.env.SUWAYOMI_PASSWORD || '';
  let defaultLang = process.env.SUWAYOMI_DEFAULT_LANG || 'zh';
  let sourceIds: string[] = [];
  let disabledSourceIds: string[] = [];
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
      authMode = normalizeSuwayomiAuthMode(
        config.SuwayomiConfig.AuthMode || authMode
      );
      username = config.SuwayomiConfig.Username || username;
      password = config.SuwayomiConfig.Password || password;
      defaultLang = config.SuwayomiConfig.DefaultLang || defaultLang;
      sourceIds = config.SuwayomiConfig.SourceIds || sourceIds;
      disabledSourceIds =
        config.SuwayomiConfig.DisabledSourceIds || disabledSourceIds;
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
    disabledSourceIds,
    maxSources,
    policyKnown,
  };
}

export async function getSuwayomiConfig(
  options: SuwayomiClientOptions = {}
): Promise<ResolvedSuwayomiConfig> {
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

/**
 * 一次 Suwayomi 請求的結果。
 *
 * 刻意回傳「已讀完的 body 字串」而不是 `Response`：body 必須在 deadline 與
 * 取消訊號的涵蓋範圍內讀完（見 suwayomiFetch 內的說明）。
 */
interface SuwayomiFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

async function suwayomiFetch(
  resolved: ResolvedSuwayomiConfig,
  input: string,
  init: RequestInit = {}
): Promise<SuwayomiFetchResult> {
  const timeoutMs = DEFAULT_SUWAYOMI_TIMEOUT_MS;

  const execute = async (
    forceSimpleLoginRefresh: boolean
  ): Promise<SuwayomiFetchResult> => {
    const authHeaders = await getSuwayomiRequestHeaders(
      resolved,
      forceSimpleLoginRefresh
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Suwayomi 请求超时(${timeoutMs}ms)`)),
      timeoutMs
    );

    // 呼叫端傳進來的 signal 必須與內建 deadline 合併，而不是被覆寫。
    // 之前這裡直接寫 `signal: controller.signal`，等於默默丟棄 init.signal ——
    // 呼叫端以為自己能取消請求，實際上取消不了，連線會一路掛到 20 秒。
    //
    // 用手動轉發而不是 AbortSignal.any()：後者雖然在 Node 24 執行期存在，
    // 但本專案的 TS lib 還沒收錄，會編譯失敗。
    const callerSignal = init.signal;
    const forwardAbort = () => {
      controller.abort(callerSignal?.reason);
    };
    if (callerSignal) {
      if (callerSignal.aborted) {
        forwardAbort();
      } else {
        callerSignal.addEventListener('abort', forwardAbort, { once: true });
      }
    }

    try {
      const response = await fetch(input, {
        ...init,
        headers: {
          ...(authHeaders || {}),
          ...(init.headers || {}),
        },
        cache: 'no-store',
        signal: controller.signal,
      });

      // body 一定要在這裡讀完，不能把 Response 交給呼叫端自己讀。
      //
      // fetch 只在「收到 response header」時 resolve。先前這個函式在那一刻
      // 就回傳，finally 隨即 clearTimeout + 移除 abort 監聽，而 body 是呼叫端
      // 在 graphqlRequest 裡才 await 的 —— 上游送完 header 就停止送 body 時，
      // 那個 await 永不 settle，20 秒 deadline 與呼叫端的取消訊號都已被拆掉，
      // socket 與 promise 永久滯留。搜尋路徑雖有 3 秒 race 讓 UI 不卡住，
      // 洩漏仍會隨每次搜尋累積；getSources／getChapterPages 這些沒有第二層
      // deadline 的路徑則會讓整個 request handler 掛死。
      //
      // 回傳字串而非 Response 也順便讓「不是合法 JSON」有明確錯誤訊息。
      const body = await response.text();
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timeoutId);
      // 呼叫端的 signal 可能比這次請求活得久（例如重試時重用），
      // 沒移除監聽會累積
      callerSignal?.removeEventListener('abort', forwardAbort);
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

/**
 * `manga(id:)` 回來的節點。
 *
 * 型別要與 GraphQL 選欄位一致：少宣告一個欄位，取用處就會被 tsc 擋掉；
 * 多宣告一個沒選的欄位，則會讓 undefined 悄悄流進回應。
 */
interface SuwayomiMangaNode {
  id: string | number;
  title?: string;
  thumbnailUrl?: string;
  sourceId?: string | number;
  description?: string;
  author?: string;
  artist?: string;
  genre?: string;
  status?: string;
  realUrl?: string;
}

/**
 * 詳情快取存的內容：**只有伺服器事實**。
 *
 * 呼叫端傳進來的 title/cover/... fallback 不可進來，否則帶 fallback 的
 * 請求會把自己的值留給後面沒帶 fallback 的請求。
 */
interface MangaDetailFacts {
  /** 產生這份事實的 Suwayomi 伺服器，用來擋跨伺服器的錯誤快取 */
  readonly serverBaseUrl: string;
  readonly trueSourceId: string;
  readonly manga: SuwayomiMangaNode;
  readonly chapters: ReadonlyArray<MangaChapter>;
}

/**
 * realUrl 只放行絕對 http(s) 網址。
 *
 * 這個值會變成前端「到來源站看留言」的連結。相對路徑會被瀏覽器接到本站
 * 網域上（看起來像站內連結，其實指向不存在的頁面），`javascript:` /
 * `data:` 之類的 scheme 更是直接的注入面。上游給不出可用的絕對網址時
 * 就不給連結 —— 誠實的「沒有」勝過猜一個。
 */
function sanitizeSourceRealUrl(value?: string): SourceExternalUrl | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    // 不帶 base：相對路徑在這裡會直接 throw，正是我們要的
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString() as SourceExternalUrl;
  } catch {
    return undefined;
  }
}

export class SuwayomiClient {
  private options: SuwayomiClientOptions;
  private sourcesHaveContentWarning = new Map<string, boolean>();
  /**
   * 每台伺服器是否支援 `realUrl` 欄位（manga 與 chapter 各自一個 key）。
   *
   * 舊版 Suwayomi 的 MangaType / ChapterType 沒有這個欄位，選進 query 會被
   * GraphQL validation 直接判 FieldUndefined，整個詳情頁對舊伺服器 100% 失敗。
   * 與 sourcesHaveContentWarning 同一套做法：樂觀先試完整選欄位，只有
   * unknown-field 錯誤才降級並記住，之後不再重撞。
   *
   * 三態：true=已確認支援、false=已撞過 unknown-field、缺席=未知。
   * 兩個欄位分開記：版本演進不保證同步，一邊缺不該拖累另一邊。
   */
  private realUrlCapability = new Map<string, boolean>();
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
  /**
   * 推薦結果快取。
   *
   * key 只含上游參數（serverBaseUrl / sourceId / type / page / filters），
   * **不含政策與使用者** —— 見 getRecommendedManga 內的說明。
   * 讀寫都在 assertSourceAllowed 之後，所以撤權者走不到這裡。
   */
  private static readonly RECOMMEND_TTL_MS = 30_000;
  private static readonly RECOMMEND_CACHE_MAX = 128;
  private recommendCache = new Map<
    string,
    {
      at: number;
      inflight?: Promise<MangaRecommendResult>;
      value?: MangaRecommendResult;
    }
  >();
  private sourcesCache = new Map<
    string,
    { at: number; inflight?: Promise<MangaSource[]>; value?: MangaSource[] }
  >();
  private mangaSourceCache = new Map<
    string,
    { at: number; sourceId: string }
  >();
  private static readonly MANGA_DETAIL_TTL_MS = 5 * 60_000;
  private static readonly MANGA_DETAIL_REFRESH_RETRY_MS = 30_000;
  private static readonly MANGA_DETAIL_CACHE_MAX = 32;
  /**
   * 漫畫詳情的來源事實快取（stale-while-revalidate）。
   *
   * 一次詳情頁載入 = manga(id:) + fetchChapters 兩發上游，而 fetchChapters
   * 還會讓 Suwayomi 去來源站重抓章節；使用者返回列表再點進來就再來一輪。
   *
   * key 是 serverBaseUrl + mangaId，**不含政策也不含使用者**：
   * 值裡沒有任何經過政策過濾的資料，而政策門與 assertSourceAllowed 在每次
   * getMangaDetail 都照跑（包含回 stale 的那次），命中快取不跳過授權。
   */
  private mangaDetailCache = new Map<
    string,
    {
      at: number;
      /** 冷啟動：尚無可回傳的值，呼叫端要等它 */
      inflight?: Promise<MangaDetailFacts>;
      /** 背景重新驗證：呼叫端不等它，失敗也只是留著舊值 */
      refresh?: Promise<void>;
      /** 上次背景刷新失敗後的最早重試時間 */
      retryAt?: number;
      value?: MangaDetailFacts;
    }
  >();

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
    resolvedConfig?: ResolvedSuwayomiConfig,
    signal?: AbortSignal
  ): Promise<T> {
    const resolved =
      resolvedConfig ?? (await resolveSuwayomiConfig(this.options));
    const response = await suwayomiFetch(resolved, resolved.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables, operationName }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Suwayomi 请求失败: ${response.status}`);
    }

    let data: GraphQLResponse<T>;
    try {
      data = JSON.parse(response.body) as GraphQLResponse<T>;
    } catch {
      // 上游反向代理故障時會回 HTML 錯誤頁；直接讓 SyntaxError 冒出來
      // 對診斷沒有幫助
      throw new Error('Suwayomi 返回的不是有效 JSON');
    }
    if (data.errors?.length) {
      throw new Error(
        data.errors.map((item) => item.message || 'Unknown error').join('; ')
      );
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
    // 政策必須進 key：快取值已套用當時的兩份清單，若 key 只有 server/lang，
    // 管理員停用來源後最長 TTL 內仍會回舊清單，等於用 TTL 延後授權撤銷。
    //
    // 用 JSON.stringify 而非 join：分隔字元會撞。
    // `allow=['1','2']` 與 `allow=['1,2']` 在 join(',') 下都是 '1,2'，
    // 較寬的政策先進快取後，較窄的政策會命中它 → 授權繞過。
    const policy = JSON.stringify([
      [...resolved.sourceIds].sort(),
      [...resolved.disabledSourceIds].sort(),
    ]);
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
          SuwayomiClient.capMap(
            this.sourcesCache,
            SuwayomiClient.SOURCES_CACHE_MAX
          );
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

    // 前綴匹配（zh 涵蓋 zh-Hant／zh-Hans）；判斷一律走 matchesSourceLang，
    // 與下面的 isMangaSourceAllowed 同理 —— 不在這裡另寫一份比對邏輯。
    const filtered = nodes.filter((item) => matchesSourceLang(item.lang, lang));
    // 判斷一律走 isMangaSourceAllowed（與 admin 面板共用同一份），
    // 不要在這裡另寫一份布林邏輯 —— 兩份會漂移。
    const scoped = unscoped
      ? filtered
      : filtered.filter((item) =>
          isMangaSourceAllowed(
            String(item.id),
            resolved.sourceIds,
            resolved.disabledSourceIds
          )
        );

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
    const requested = (
      Array.isArray(sourceId) ? sourceId : sourceId ? [sourceId] : []
    )
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
      return (await this.getSources(resolved.defaultLang)).slice(
        0,
        resolved.maxSources
      );
    } catch (error) {
      // fail-closed 的授權錯誤絕不可被 fallback 吞掉 ——
      // 否則「政策不可信」或「剛被停用」會被降級成「來源清單暫時取不到」，
      // 然後用較舊的快照把被停用的來源放行。
      if (error instanceof MangaSourceForbiddenError) {
        throw error;
      }
      if (resolved.sourceIds.length === 0) {
        throw error;
      }
      // 重新解析政策：上面的 resolved 可能已經過期（管理員剛改了黑名單），
      // 用舊快照組清單就等於用舊政策授權。
      const fresh = await resolveSuwayomiConfig(this.options);
      if (!fresh.policyKnown) {
        throw new MangaSourceForbiddenError(
          '无法读取来源限制设置，已暂时拒绝访问'
        );
      }
      const usable = fresh.sourceIds.filter(
        (id) =>
          id !== MANGA_DISABLE_ALL_SENTINEL &&
          isMangaSourceAllowed(id, fresh.sourceIds, fresh.disabledSourceIds)
      );
      if (usable.length === 0) {
        throw new MangaSourceForbiddenError();
      }
      return usable.slice(0, fresh.maxSources).map((id) => ({
        id,
        displayName: id,
        name: id,
      }));
    }
  }

  async searchMangaSource(
    keyword: string,
    source: MangaSearchSourceRef,
    page = 1,
    signal?: AbortSignal
  ): Promise<MangaSourceSearchResponse> {
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
      'GET_SOURCE_MANGAS_FETCH',
      undefined,
      signal
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

  /**
   * 在 per-source 上限內搜尋單一來源，永不 reject。
   *
   * REST（searchManga）與 SSE（/api/manga/search/ws）都必須走這裡：兩條路徑
   * 最後都會 await 全部來源才算完成 —— WS 雖然能逐顆先送 `source_result`，
   * 但 `complete` 仍在 Promise.all 之後，而前端要收到 `complete` 才會停止
   * loading。所以上限只修 REST 沒有用，兩邊得共用同一份實作。
   */
  async searchMangaSourceWithDeadline(
    keyword: string,
    source: MangaSearchSourceRef,
    page = 1
  ): Promise<MangaSourceSearchOutcome> {
    const startedAt = Date.now();
    const sourceName = source.displayName || source.name || String(source.id);

    // abort 只是 best-effort 回收連線：底層 loginWithSimpleAuth() 的 fetch
    // 沒有 signal，卡在登入時取消不了。因此 deadline 的「保證」來自下面這個
    // 一定會 settle 的計時器，不依賴請求能否被取消。
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 本來想用 Promise.withResolvers()，但專案 TypeScript 是 4.9.5，
    // 它的 esnext lib 還沒有這個宣告（執行期 Node 24 有），會編譯失敗。
    const deadline = new Promise<SearchDeadlineSentinel>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(
          new Error(`来源搜索超时(${PER_SOURCE_SEARCH_TIMEOUT_MS}ms)`)
        );
        resolve(SEARCH_DEADLINE);
      }, PER_SOURCE_SEARCH_TIMEOUT_MS);
    });

    try {
      // Promise.race 會替兩邊都掛上 handler，所以逾時後那個仍在進行的請求
      // 即使稍後 reject 也已算被處理，不會變成 unhandledRejection。
      const outcome = await Promise.race([
        this.searchMangaSource(keyword, source, page, controller.signal),
        deadline,
      ]);

      // 用 `in` 判別而不是 `=== SEARCH_DEADLINE`：後者比對的是物件參照，
      // TypeScript 不會據此窄化 union，`outcome.results` 會編譯失敗。
      if ('deadlineReached' in outcome) {
        const error = `搜索超时（超过 ${PER_SOURCE_SEARCH_TIMEOUT_MS}ms）`;
        console.warn(
          `[Suwayomi] manga search source timed out: ${source.id} - ${error}`
        );
        return {
          status: 'failed',
          source,
          sourceName,
          error,
          elapsedMs: Date.now() - startedAt,
          timedOut: true,
        };
      }

      return {
        status: 'ok',
        source,
        sourceName,
        results: outcome.results,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      console.warn(
        `[Suwayomi] manga search source failed: ${source.id} - ${message}`
      );
      return {
        status: 'failed',
        source,
        sourceName,
        error: message,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
      };
    } finally {
      clearTimeout(timer);
    }
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
      sources.map((source) =>
        this.searchMangaSourceWithDeadline(keyword, source, page)
      )
    );

    for (const outcome of perSourceResults) {
      measurements.push({
        sourceId: String(outcome.source.id),
        elapsedMs: outcome.elapsedMs,
        failed: outcome.status === 'failed',
        timedOut: outcome.status === 'failed' ? outcome.timedOut : false,
      });

      if (outcome.status === 'failed') {
        failedSources.push({
          sourceId: String(outcome.source.id),
          sourceName: outcome.sourceName,
          error: outcome.error,
          // 上一行的 measurements 就用了 outcome.timedOut，這裡先前漏帶，
          // 導致非流式路徑的失敗橫幅永遠分不出超時與故障
          timedOut: outcome.timedOut,
        });
        continue;
      }

      for (const manga of outcome.results) {
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
            ... on CheckBoxFilter { name }
            ... on GroupFilter {
              name
              filters {
                __typename
                ... on CheckBoxFilter { name }
                ... on SelectFilter { name values }
              }
            }
          }
        }
      }
    `;

    interface RawFilter {
      __typename?: string;
      name?: string;
      values?: string[];
      filters?: Array<{
        __typename?: string;
        name?: string;
        values?: string[];
      }>;
    }
    const data = await this.graphqlRequest<{
      source?: { filters?: RawFilter[] };
    }>(query, { id: sourceId }, 'GetSourceFilters');

    const raw = data.source?.filters || [];
    const options: MangaSourceFilterOption[] = [];
    /**
     * 純視覺型別：本來就不該渲染成可選項，略過它們不是「丟棄功能」。
     * 不列入下面的警告，否則每顆來源都會噪音。
     */
    const DECORATIVE = new Set(['HeaderFilter', 'SeparatorFilter']);
    /** 被略過且**有功能意義**的型別，收集起來一次性警告 */
    const dropped: string[] = [];

    raw.forEach((filter, position) => {
      // 刻意不在這裡統一擋 !filter.name：未支援型別（TextFilter 等）
      // 的 name 根本沒被 query 出來，統一擋掉會讓它們在下面的
      // dropped 統計裡永遠不出現，警告等於失效。
      if (
        filter.__typename === 'SelectFilter' ||
        filter.__typename === 'SortFilter'
      ) {
        // 型別支援但內容不合格同樣是「功能被丟棄」，靜默 return 會讓
        // 「來源明明有這個下拉、UI 卻沒有」再次變成無線索的問題。
        if (!filter.name) {
          dropped.push(`${filter.__typename}（第 ${position} 項）缺少名稱`);
          return;
        }
        const values = (filter.values || []).filter(
          (v): v is string => typeof v === 'string'
        );
        if (values.length === 0) {
          dropped.push(`${filter.__typename}「${filter.name}」沒有可選值`);
          return;
        }
        options.push({
          position,
          kind: filter.__typename === 'SelectFilter' ? 'select' : 'sort',
          name: filter.name,
          values,
        });
        return;
      }

      if (filter.__typename === 'CheckBoxFilter') {
        if (!filter.name) {
          dropped.push(`CheckBoxFilter（第 ${position} 項）缺少名稱`);
          return;
        }
        options.push({ position, kind: 'checkbox', name: filter.name });
        return;
      }

      if (filter.__typename === 'GroupFilter') {
        const groupName = filter.name || '(未命名群組)';
        // 群組內取 CheckBox（→ chip 多選）與 Select（→ 一般下拉，實測喜漫的
        // 「分组标签」群組內是 4 個 SelectFilter）。innerPosition 必須是**群組
        // 內原始位置**：群組內混有其他型別時，用過濾後的索引會讓 groupChange
        // 改錯項。
        const checkboxes: { position: number; name: string }[] = [];

        /*
         * 逐項判斷，而不是「整組零可渲染才記一筆」：混合群組
         * （例如 [CheckBoxFilter, TextFilter]）只要有一項渲染得出來，
         * 其餘有功能意義的項目就會既不進 options 也不進 dropped 而靜默消失。
         * 逐項判斷也順帶讓「只含 Header/Separator 的純裝飾群組」不再被誤報。
         */
        (filter.filters || []).forEach((item, innerPosition) => {
          const innerType = item.__typename || 'unknown';
          if (DECORATIVE.has(innerType)) return;

          if (innerType === 'CheckBoxFilter') {
            if (typeof item.name === 'string' && item.name.length > 0) {
              checkboxes.push({ position: innerPosition, name: item.name });
            } else {
              dropped.push(`群組「${groupName}」內 CheckBoxFilter 缺少名稱`);
            }
            return;
          }

          if (innerType === 'SelectFilter') {
            if (typeof item.name !== 'string' || item.name.length === 0) {
              dropped.push(`群組「${groupName}」內 SelectFilter 缺少名稱`);
              return;
            }
            const values = (item.values || []).filter(
              (v): v is string => typeof v === 'string'
            );
            if (values.length === 0) {
              dropped.push(
                `群組「${groupName}」內 SelectFilter「${item.name}」沒有可選值`
              );
              return;
            }
            options.push({
              position,
              kind: 'group_select',
              innerPosition,
              name: item.name,
              values,
            });
            return;
          }

          dropped.push(`群組「${groupName}」內 ${innerType}`);
        });

        /*
         * 刻意不去安排 group 與 group_select 在這個陣列裡的先後：消費端
         * （page.tsx）是依 kind 分四趟過濾渲染的 —— select|sort、group_select、
         * checkbox 三趟畫在 grid 內，group chip 那趟畫在 grid 外，顯示順序
         * 由那邊的結構決定，與這裡的陣列順序無關。
         * 先前為此緩衝 group_select 的寫法是無效的結構。
         */
        if (checkboxes.length > 0) {
          options.push({
            position,
            kind: 'group',
            name: groupName,
            options: checkboxes,
          });
        }
        return;
      }

      if (!DECORATIVE.has(filter.__typename || '')) {
        // 未支援型別的 name 沒被 query，只報型別；有 name 才附上
        dropped.push(
          filter.name
            ? `${filter.__typename}「${filter.name}」`
            : String(filter.__typename)
        );
      }
    });

    if (dropped.length > 0) {
      const warnKey = `${sourceId}|${dropped.join('；')}`;
      if (!warnedDroppedFilters.has(warnKey)) {
        warnedDroppedFilters.add(warnKey);
        console.warn(
          `[Suwayomi] 來源 ${sourceId} 有無法渲染的 filter，已略過：${dropped.join(
            '；'
          )}`
        );
      }
    }
    return options;
  }

  /**
   * 主動探測單一來源：POPULAR 與 SEARCH 各抓一次第一頁並計時。
   *
   * **兩種都要測**，因為它們會各自壞掉，只測一種會誤導：
   * 實測 53 個來源，有 4 個 POPULAR 正常但 SEARCH 失敗
   * （《崩坏3》IP站的擴充套件根本沒實作搜尋、嗶哩漫畫拿不到搜尋憑證），
   * 也有 2 個 POPULAR 逾時但 SEARCH 正常（18漫画、JComic）。
   * 只看單一顆燈，兩個方向都會判錯。
   *
   * **刻意不套 assertSourceAllowed**：管理面板需要能測「目前被停用」的來源，
   * 才能判斷要不要啟用它。因此呼叫端必須是管理員專用路徑
   * （`/api/admin/manga-sources`），一般使用者入口不可呼叫這個方法。
   *
   * 這是管理員明確按下按鈕才觸發的診斷動作，不是背景自動輪詢 ——
   * 自動對所有來源發請求等於替使用者去打漫畫站。
   */
  async probeSource(sourceId: string): Promise<MangaSourceProbe> {
    // 兩種能力併發測，總耗時取決於較慢那個而不是相加
    const [popular, search] = await Promise.all([
      this.probeCapability(sourceId, 'POPULAR'),
      this.probeCapability(sourceId, 'SEARCH'),
    ]);
    return { popular, search };
  }

  /** 測單一種能力；永不 reject，失敗以 ok: false 表達 */
  private async probeCapability(
    sourceId: string,
    type: 'POPULAR' | 'SEARCH'
  ): Promise<MangaSourceProbeOutcome> {
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
        {
          input: {
            source: sourceId,
            type,
            page: 1,
            // SEARCH 一定要帶關鍵詞，否則擴充套件會走到不同分支
            ...(type === 'SEARCH' ? { query: PROBE_SEARCH_KEYWORD } : {}),
          },
        },
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

  /**
   * 單一來源的瀏覽／搜尋。
   *
   * `keyword` 讓推薦頁能在**該來源內**搜尋並同時套用它自己的 filter ——
   * 有些來源的 filter 本身就是為關鍵字設計的（實測禁漫天堂有「搜索范围」：
   * 站内搜索／作品／作者／标签／登场人物），沒有關鍵字時那個 filter 完全
   * 沒有作用。與 /manga/search 的多源 fan-out 互補：那邊是廣度（多選來源、
   * 不套 filter），這邊是深度（單源 + 該源完整 filter）。
   */
  async getRecommendedManga(
    sourceId: string,
    type: MangaRecommendType = 'POPULAR',
    page = 1,
    filters: MangaFilterSelection[] = [],
    keyword = ''
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

    // 授權必須在快取之前 —— 這是整個設計安全的關鍵。
    const matchedSource = await this.assertSourceAllowed(sourceId);

    // 快取 key 刻意**不含**政策與使用者。
    //
    // 同一組 (serverBaseUrl, sourceId, type, page, filters) 的上游 payload
    // 對任何使用者、任何白／黑名單狀態都完全相同 —— 政策決定的是「能不能
    // 發這個呼叫」（上面那行 assertSourceAllowed），不是「回來的內容長怎樣」。
    // 因為政策從未影響快取內容，結構上就不可能透過快取洩漏授權；
    // 被撤權的使用者在上一行就已經被擋掉，走不到這裡。
    //
    // serverBaseUrl 必須進 key：換 Suwayomi 伺服器後同一組參數是不同內容。
    const resolvedForCache = await resolveSuwayomiConfig(this.options);
    // keyword 與 filters 任一存在就必須走 SEARCH，且兩者都要進快取 key ——
    // 只看 filters 的話，「只輸關鍵字不套 filter」會走 POPULAR（關鍵字被
    // 忽略）並命中沒有關鍵字的舊快取。
    const trimmedKeyword = keyword.trim();
    const useSearch = filters.length > 0 || trimmedKeyword.length > 0;
    const cacheKey = JSON.stringify([
      resolvedForCache.serverBaseUrl,
      sourceId,
      useSearch ? 'SEARCH' : type,
      page,
      trimmedKeyword,
      buildFilterChangeInputs(filters),
    ]);
    const cachedHit = this.recommendCache.get(cacheKey);
    const nowMs = Date.now();
    if (cachedHit) {
      if (cachedHit.inflight) return cachedHit.inflight;
      if (
        cachedHit.value &&
        nowMs - cachedHit.at < SuwayomiClient.RECOMMEND_TTL_MS
      ) {
        return cachedHit.value;
      }
    }
    const inflight = (async (): Promise<MangaRecommendResult> => {
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
          input: useSearch
            ? {
                // Suwayomi 只在 SEARCH 模式套用 filters；POPULAR/LATEST 會忽略。
                // 空 query + filters = 以該來源自己的分類／排序瀏覽；
                // 有 query 則是在這個來源內搜尋（可同時套 filter）。
                type: 'SEARCH',
                source: sourceId,
                page,
                query: trimmedKeyword,
                filters: buildFilterChangeInputs(filters),
              }
            : {
                type,
                source: sourceId,
                page,
              },
        },
        'GET_SOURCE_MANGAS_FETCH'
      );

      const mangas = (data.fetchSourceManga?.mangas || []).map((manga) => ({
        id: String(manga.id),
        sourceId: String(manga.sourceId || sourceId),
        sourceName:
          matchedSource?.displayName || matchedSource?.name || sourceId,
        title: manga.title || '未命名漫画',
        cover: buildSuwayomiImageProxyUrl(manga.thumbnailUrl || ''),
        description: manga.description,
        author: manga.author,
        artist: manga.artist,
        genre: manga.genre,
        status: normalizeMangaStatus(manga.status),
      }));

      // 順手把 mangaId→sourceId 填進快取：這裡已經知道每本的來源，
      // 不填的話圖片代理對每張封面都要再打一次 manga(id:) 反查。
      for (const manga of mangas) {
        this.rememberMangaSource(
          resolvedForCache.serverBaseUrl,
          manga.id,
          manga.sourceId
        );
      }

      return {
        hasNextPage: Boolean(data.fetchSourceManga?.hasNextPage),
        mangas,
      };
    })();

    const published = inflight
      .then((value) => {
        // compare-and-set：容量汰除或後續呼叫可能已讓 key 指向別的 inflight
        if (this.recommendCache.get(cacheKey)?.inflight === published) {
          this.recommendCache.delete(cacheKey);
          this.recommendCache.set(cacheKey, { at: Date.now(), value });
          SuwayomiClient.capMap(
            this.recommendCache,
            SuwayomiClient.RECOMMEND_CACHE_MAX
          );
        }
        return value;
      })
      .catch((error) => {
        // 失敗不留快取
        if (this.recommendCache.get(cacheKey)?.inflight === published) {
          this.recommendCache.delete(cacheKey);
        }
        throw error;
      });

    this.recommendCache.set(cacheKey, { at: nowMs, inflight: published });
    SuwayomiClient.capMap(
      this.recommendCache,
      SuwayomiClient.RECOMMEND_CACHE_MAX
    );
    return published;
  }

  /**
   * realUrl 舊 schema 相容協商：manga / chapter 共用同一套三態規則。
   *
   * false=已知舊 schema，直接發 legacy，不再每次先撞一發；true 或缺席=樂觀
   * 先試完整選欄位。只有成功才記「支援」（暫時性故障不可被記成能力事實），
   * 也只有 unknown-field 才降級 —— 連線失敗、HTTP 非 2xx、一般 GraphQL 錯誤
   * 都是真錯，原樣上拋；把它們當成 schema 差異會把故障偽裝成「這台不支援
   * realUrl」。
   */
  private async negotiateRealUrlField<T>(
    capKey: string,
    realUrlField: string,
    run: (field: string) => Promise<T>
  ): Promise<T> {
    if (this.realUrlCapability.get(capKey) === false) return run('');
    try {
      const value = await run(realUrlField);
      this.realUrlCapability.set(capKey, true);
      return value;
    } catch (error) {
      if (!isSuwayomiUnknownFieldError(error)) {
        throw error;
      }
      this.realUrlCapability.set(capKey, false);
      return run('');
    }
  }

  async getChapters(
    mangaId: string,
    resolvedConfig?: ResolvedSuwayomiConfig
  ): Promise<MangaChapter[]> {
    // 詳情路徑會把自己的 snapshot 傳進來：manga 與 chapters 必須來自同一台
    // 伺服器，中途 admin 換 ServerURL 會讓兩者拼成不同漫畫的混合體。
    const resolved =
      resolvedConfig ?? (await resolveSuwayomiConfig(this.options));
    const buildMutation = (realUrlField: string) => `
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
            uploadDate${realUrlField}
          }
        }
      }
    `;

    type ChaptersData = {
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
          realUrl?: string;
        }>;
      };
    };

    const run = (realUrlField: string) =>
      this.graphqlRequest<ChaptersData>(
        buildMutation(realUrlField),
        { input: { mangaId: Number(mangaId) || mangaId } },
        'GET_MANGA_CHAPTERS_FETCH',
        resolved
      );

    const data = await this.negotiateRealUrlField(
      `${resolved.serverBaseUrl}::chapter`,
      '\n            realUrl',
      run
    );

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
      realUrl: sanitizeSourceRealUrl(chapter.realUrl),
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
    operationName: string,
    resolvedConfig?: ResolvedSuwayomiConfig
  ): Promise<{ data: T; resolved: ResolvedSuwayomiConfig }> {
    const resolved =
      resolvedConfig ?? (await resolveSuwayomiConfig(this.options));
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
        if (
          !/VariableTypeMismatch|of type .* used in position/i.test(
            error instanceof Error ? error.message : String(error)
          )
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /**
   * 記住 mangaId 屬於哪個來源。
   *
   * 圖片代理只有 mangaId，必須反查來源才能驗權；沒有這份快取的話
   * 一頁 24 張封面就是 24 次額外的 manga(id:) GraphQL。
   * key 含 serverBaseUrl：換伺服器後同一個 mangaId 是不同漫畫。
   */
  private rememberMangaSource(
    serverBaseUrl: string,
    mangaId: string,
    sourceId: string
  ): void {
    const key = `${serverBaseUrl}::${mangaId}`;
    this.mangaSourceCache.delete(key);
    this.mangaSourceCache.set(key, { at: Date.now(), sourceId });
    SuwayomiClient.capMap(
      this.mangaSourceCache,
      SuwayomiClient.MANGA_SOURCE_CACHE_MAX
    );
  }

  /**
   * 從伺服器查出 manga 真正所屬的 sourceId。
   *
   * 授權判斷絕不能信客戶端傳來的 sourceId：攻擊者只要拿「允許來源的 id」
   * 配上「被停用來源的 mangaId」就能繞過。這裡回傳的是伺服器的事實。
   */
  private async resolveMangaSource(
    mangaId: string,
    resolvedConfig?: ResolvedSuwayomiConfig
  ): Promise<{
    sourceId: string;
    /** 這次查詢實際使用的伺服器；呼叫端須與自己的快取 namespace 比對 */
    serverBaseUrl: string;
    manga: SuwayomiMangaNode;
  }> {
    const snapshotConfig =
      resolvedConfig ?? (await resolveSuwayomiConfig(this.options));
    const buildQuery =
      (realUrlField: string) => (idType: 'Int!' | 'LongString!') =>
        `
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
          status${realUrlField}
        }
      }
    `;
    const run = (realUrlField: string) =>
      this.graphqlNodeQuery<{ manga?: SuwayomiMangaNode }>(
        buildQuery(realUrlField),
        mangaId,
        'MangaDetail',
        snapshotConfig
      );

    // 與 getChapters 分開記：MangaType 有 realUrl 不代表 ChapterType 也有。
    const { data, resolved: snapshot } = await this.negotiateRealUrlField(
      `${snapshotConfig.serverBaseUrl}::manga`,
      '\n          realUrl',
      run
    );

    const manga = data.manga;
    const resolved = manga?.sourceId;
    if (!resolved) {
      // 查不到歸屬就無法判斷是否被停用 —— 授權路徑必須 fail closed，
      // 不可退回客戶端提供的 sourceId。
      throw new MangaSourceForbiddenError('无法确认该漫画的来源，已拒绝访问');
    }

    const sourceId = String(resolved);
    // key 必須用「發出這次查詢的那份 snapshot」的 serverBaseUrl。
    // 若在這裡重新 resolve，查詢期間管理員換了 Suwayomi 伺服器的話，
    // 舊伺服器的來源歸屬會被寫進新伺服器的 namespace，造成跨來源授權繞過。
    this.rememberMangaSource(snapshot.serverBaseUrl, mangaId, sourceId);
    return {
      sourceId,
      serverBaseUrl: snapshot.serverBaseUrl,
      manga,
    };
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
        : (await this.resolveMangaSource(mangaId, resolved)).sourceId;
    // assertSourceAllowed 仍然每次都跑：它讀的是（已快取的）來源清單，
    // 管理員改 SourceIds 後會在 SOURCES_TTL_MS 內生效。
    await this.assertSourceAllowed(sourceId);
  }

  /**
   * 抓一輪詳情事實。整輪綁在同一份 snapshot 上（manga 與 chapters 打同一台）。
   *
   * 先驗權再取內容：getChapters 也會外發請求，順序顛倒等於先洩漏再檢查。
   */
  private async fetchMangaDetailFacts(
    snapshot: ResolvedSuwayomiConfig,
    mangaId: string
  ): Promise<MangaDetailFacts> {
    const resolvedSource = await this.resolveMangaSource(mangaId, snapshot);
    await this.assertSourceAllowed(resolvedSource.sourceId);
    return {
      // key 與 value 同源，跨伺服器汙染在資料流上就不可能發生
      serverBaseUrl: snapshot.serverBaseUrl,
      trueSourceId: resolvedSource.sourceId,
      manga: resolvedSource.manga,
      chapters: await this.getChapters(mangaId, snapshot),
    };
  }

  /**
   * 背景重新驗證。呼叫端已經拿著 stale 值走了，這裡不阻塞任何人。
   *
   * 網路／上游暫時失敗時保留舊 value 與**舊 at**，下一次呼叫仍可立即回覆；
   * 背景重試有 30 秒 backoff，避免故障期間每個 request 都打來源。來源歸屬或
   * 政策已禁止則刪除 stale，下一次必須重新 fail closed。整條背景鏈自己收斂
   * rejection —— 沒有人 await 它，漏出去就是 unhandled rejection。
   */
  private refreshMangaDetailFacts(
    key: string,
    snapshot: ResolvedSuwayomiConfig,
    mangaId: string
  ): void {
    const refresh: Promise<void> = this.fetchMangaDetailFacts(snapshot, mangaId)
      .then((value) => {
        // compare-and-set：容量汰除或後續呼叫可能已讓這個 key 指向別的一輪，
        // 較舊的 refresh 不可覆寫較新的結果
        const entry = this.mangaDetailCache.get(key);
        if (entry?.refresh !== refresh) return;
        this.mangaDetailCache.delete(key);
        this.mangaDetailCache.set(key, { at: Date.now(), value });
      })
      .catch((error) => {
        const entry = this.mangaDetailCache.get(key);
        if (entry?.refresh !== refresh) return;
        if (error instanceof MangaSourceForbiddenError) {
          // 來源歸屬／政策已變成禁止：舊來源的 stale 不能繼續冒充可用內容。
          this.mangaDetailCache.delete(key);
          return;
        }
        // 一般暫時失敗保留 stale，並短暫節流；舊 at 仍表示內容已過期。
        this.mangaDetailCache.set(key, {
          at: entry.at,
          retryAt: Date.now() + SuwayomiClient.MANGA_DETAIL_REFRESH_RETRY_MS,
          value: entry.value,
        });
      });

    const current = this.mangaDetailCache.get(key);
    // 這一瞬間條目已被汰除的話就不要復活它：一筆沒有 value 的殘骸會讓
    // 下一位呼叫者以為有東西可等
    if (!current) return;
    this.mangaDetailCache.set(key, { ...current, refresh });
  }

  /**
   * 詳情的「來源事實」快取：5 分鐘 TTL、上限 32、同 key 併發合併成一發，
   * 過期後 stale-while-revalidate。
   *
   * 一次詳情頁載入是 manga(id:) + fetchChapters 兩發上游，而 fetchChapters
   * 還會讓 Suwayomi 去來源站重抓；使用者返回列表再點回來就再來一輪，
   * 書架批次更新同一部漫畫也會重複打。詳情內容變動慢，過了 TTL 讓下一位
   * 使用者空等一整輪不划算 —— 手上有值就先交出去，背景更新完下一位拿新的。
   *
   * 快取裡只有伺服器事實 —— 授權完全不在裡面：政策門由呼叫端在進來之前
   * 用最新的 config 擋，assertSourceAllowed 在這裡（冷啟動與背景更新都在
   * 送 getChapters 之前）與 getMangaDetail 尾端各跑一次，所以無論回的是
   * 新值還是 stale 值，都不會跳過任何一道檢查。
   */
  private loadMangaDetailFacts(
    snapshot: ResolvedSuwayomiConfig,
    mangaId: string
  ): Promise<MangaDetailFacts> {
    const key = `${snapshot.serverBaseUrl}::${mangaId}`;
    const now = Date.now();
    const hit = this.mangaDetailCache.get(key);

    if (hit?.value) {
      // 已過期且 backoff 結束就起一輪背景更新（同 key 最多一輪），立刻回舊值。
      if (
        now - hit.at >= SuwayomiClient.MANGA_DETAIL_TTL_MS &&
        !hit.refresh &&
        (!hit.retryAt || now >= hit.retryAt)
      ) {
        this.refreshMangaDetailFacts(key, snapshot, mangaId);
      }
      return Promise.resolve(hit.value);
    }
    // 冷啟動：沒有任何值可交，併發者一起等同一發
    if (hit?.inflight) return hit.inflight;

    const inflight: Promise<MangaDetailFacts> = this.fetchMangaDetailFacts(
      snapshot,
      mangaId
    )
      .then((value) => {
        // compare-and-set：容量汰除或後續呼叫可能已讓這個 key 指向別的
        // inflight，較舊的 promise 不可覆寫較新的結果
        if (this.mangaDetailCache.get(key)?.inflight === inflight) {
          this.mangaDetailCache.delete(key);
          this.mangaDetailCache.set(key, { at: Date.now(), value });
          SuwayomiClient.capMap(
            this.mangaDetailCache,
            SuwayomiClient.MANGA_DETAIL_CACHE_MAX
          );
        }
        return value;
      })
      .catch((error) => {
        // 冷啟動失敗不留快取，下次重新嘗試；同樣只清掉自己那一筆
        if (this.mangaDetailCache.get(key)?.inflight === inflight) {
          this.mangaDetailCache.delete(key);
        }
        throw error;
      });

    this.mangaDetailCache.set(key, { at: now, inflight });
    SuwayomiClient.capMap(
      this.mangaDetailCache,
      SuwayomiClient.MANGA_DETAIL_CACHE_MAX
    );
    return inflight;
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
    // 政策門與 snapshot 合併成同一次 resolve：檢查的與使用的是同一份 config，
    // 兩次 resolve 之間沒有縫。政策未知要在送出任何上游請求之前擋掉，
    // 快取命中也一樣要先過這道。
    const snapshot = await resolveSuwayomiConfig(this.options);
    if (!snapshot.policyKnown) {
      throw new MangaSourceForbiddenError(
        '无法读取来源限制设置，已暂时拒绝访问'
      );
    }
    let facts = await this.loadMangaDetailFacts(snapshot, input.mangaId);

    // 這一輪期間 admin 可能換掉 ServerURL。facts 本身自洽（整輪綁同一台），
    // 但回給使用者的內容應該屬於「現在這台」——否則後續用 chapterId 發的
    // 請求會打到新伺服器而對不上。重試上限 1 次，絕不迴圈：連續切換時
    // 回傳第二輪的自洽事實即可，快取仍零汙染（key 與 value 同源）。
    const fresh = await resolveSuwayomiConfig(this.options);
    if (fresh.policyKnown && fresh.serverBaseUrl !== facts.serverBaseUrl) {
      facts = await this.loadMangaDetailFacts(fresh, input.mangaId);
    }

    // 授權永遠最後、永遠用最新政策：重試之後才驗，保證真正回傳的
    // trueSourceId 過的是當下白名單。管理員停用來源後會在 SOURCES_TTL_MS
    // 內生效，不受 5 分鐘詳情內容 TTL 影響。
    await this.assertSourceAllowed(facts.trueSourceId);

    const manga = facts.manga;
    return {
      id: String(manga.id),
      sourceId: facts.trueSourceId,
      sourceName: input.sourceName || facts.trueSourceId,
      title: manga.title || input.title || '漫画详情',
      cover: buildSuwayomiImageProxyUrl(
        manga.thumbnailUrl || input.cover || ''
      ),
      description: manga.description || input.description,
      author: manga.author || input.author,
      artist: manga.artist,
      genre: manga.genre,
      status: normalizeMangaStatus(manga.status || input.status),
      // realUrl 只認伺服器給的絕對網址，呼叫端無法注入
      realUrl: sanitizeSourceRealUrl(manga.realUrl),
      // 陣列本身屬於共用快取；交付淺拷貝，避免呼叫端 push/sort 改到快取。
      chapters: [...facts.chapters],
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
    }>(
      mutation,
      { input: { chapterId: Number(chapterId) || chapterId } },
      'GET_CHAPTER_PAGES_FETCH'
    );

    return (data.fetchChapterPages?.pages || []).map((item) =>
      buildSuwayomiImageProxyUrl(item)
    );
  }
}

export const suwayomiClient = new SuwayomiClient();
