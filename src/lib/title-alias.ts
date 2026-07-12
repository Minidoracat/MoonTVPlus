/* eslint-disable no-console */

/**
 * 三地片名别名搜索（服务端）
 *
 * 通过豆瓣定位条目并读取「又名」，将用户输入的任一地区译名
 * （如台湾「刺激1995」/ 香港「月黑高飞」/ 大陆「肖申克的救赎」）
 * 扩展为多个关键词一并搜索资源站。解析失败或超时自动降级为仅用原词搜索。
 */

import { ApiSite, getConfig } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

interface DoubanSuggestItem {
  id: string;
  title: string;
  year?: string;
  type?: string;
}

interface DoubanSubjectDetail {
  title?: string;
  aka?: string[];
}

interface TMDBSearchItem {
  id: number;
  media_type?: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  known_for?: TMDBSearchItem[];
  popularity?: number;
  vote_count?: number;
}

interface TMDBSearchResponse {
  results?: TMDBSearchItem[];
}

interface TMDBDetailResponse {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
}

interface TMDBCombinedCreditsResponse {
  cast?: TMDBSearchItem[];
  crew?: TMDBSearchItem[];
}

export type TitleAliasMode = 'title' | 'person';

const aliasCache = new Map<string, { aliases: string[]; expires: number }>();
const ALIAS_CACHE_TTL = 24 * 60 * 60 * 1000; // 别名几乎不变，缓存 24 小时
const ALIAS_NEGATIVE_TTL = 5 * 60 * 1000; // 解析失败短缓存，避免豆瓣被挡时反复重试拖慢搜索
const ALIAS_CACHE_MAX = 500;
const MAX_ALIASES = 5;
// 人物模式要覆盖代表作之外的作品，靠 SSE 分批渐进搜索消化数量
const MAX_PERSON_ALIASES = 30;
const MAX_SUBJECT_CANDIDATES = 6;
const RESOLVE_TIMEOUT = 4500;
const DOUBAN_TIMEOUT = 3500;
const TMDB_TIMEOUT = 2500;
// 人物解析需要 search + combined_credits 两次串行请求（各受 TMDB_TIMEOUT=2.5s 上限）
// 加上简繁变体扇出的尾延迟，最坏超过 5s；4s 预算必然偶发静默超时并被负缓存放大。
// 人物模式没有别名就搜不到任何东西，宁可多等一点
const PERSON_RESOLVE_TIMEOUT = 8000;

const CJK_REGEX = /[一-鿿]/;

function setAliasCache(key: string, aliases: string[], ttl = ALIAS_CACHE_TTL) {
  if (aliasCache.size >= ALIAS_CACHE_MAX) {
    const oldest = aliasCache.keys().next().value;
    if (oldest !== undefined) aliasCache.delete(oldest);
  }
  aliasCache.set(key, { aliases, expires: Date.now() + ttl });
}

function cleanAliasName(name: string): string {
  return name.replace(/[（(]\s*[港台澳]\s*[)）]\s*$/, '').trim();
}

function normalizeAliasName(name: string): string {
  return cleanAliasName(name).replace(/\s+/g, '').toLowerCase();
}

type ScriptConverter = (text: string) => string;
interface ScriptConverters {
  t2s: ScriptConverter;
  s2t: ScriptConverter;
}

let scriptConvertersPromise: Promise<ScriptConverters | null> | null = null;

/**
 * 简繁字形转换器（服务端）：查询词与 TMDB/豆瓣返回的片名、人名可能分属
 * 简繁两种字形（如「高桥一生」vs「高橋一生」），比对与检索前需归一。
 */
function getScriptConverters(): Promise<ScriptConverters | null> {
  if (!scriptConvertersPromise) {
    scriptConvertersPromise = import('opencc-js')
      .then((module) => {
        const OpenCC = module.default || module;
        return {
          t2s: OpenCC.Converter({ from: 't', to: 'cn' }),
          s2t: OpenCC.Converter({ from: 'cn', to: 't' }),
        };
      })
      .catch((error) => {
        console.warn(
          '[TitleAlias] 加载 opencc-js 转换器失败:',
          (error as Error).message
        );
        scriptConvertersPromise = null; // 允许下次重试
        return null;
      });
  }
  return scriptConvertersPromise;
}

// 仅用于候选匹配打分（统一转简体再比对）；不要用在 orderAliases 的去重上，
// 否则会滤掉与查询词只差简繁字形、但资源站检索需要的别名变体
function normalizeForMatch(name: string, cc: ScriptConverters | null): string {
  const normalized = normalizeAliasName(name);
  return cc ? cc.t2s(normalized) : normalized;
}

function orderAliases(
  names: string[],
  query: string,
  limit = MAX_ALIASES
): string[] {
  const normalizedQuery = normalizeAliasName(query);
  const unique = Array.from(
    new Set(
      names
        .map(cleanAliasName)
        .filter((name) => name && normalizeAliasName(name) !== normalizedQuery)
    )
  );

  // 中文片名优先：资源站基本以中文片名收录
  return [
    ...unique.filter((name) => CJK_REGEX.test(name)),
    ...unique.filter((name) => !CJK_REGEX.test(name)),
  ].slice(0, limit);
}

function withFallbackTimeout<T>(promise: Promise<T>, ms: number, fallback: T) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function getRegionalTitleAliases(query: string): string[] {
  const normalized = cleanAliasName(query);
  const prefix = normalized.slice(0, -1);
  const last = normalized.slice(-1);
  if (prefix.length < 2) return [];

  if (last === '人') return [`${prefix}侠`, `${prefix}俠`];
  if (last === '侠' || last === '俠') return [`${prefix}人`];
  return [];
}

function getTMDBTitle(item?: TMDBSearchItem | TMDBDetailResponse | null) {
  return (
    item?.title ||
    item?.name ||
    item?.original_title ||
    item?.original_name ||
    ''
  );
}

function getTMDBTitles(item?: TMDBSearchItem | null): string[] {
  if (!item) return [];
  return [getTMDBTitle(item), item.original_title || item.original_name || ''];
}

function sortTMDBItemsByPopularity(items: TMDBSearchItem[]): TMDBSearchItem[] {
  return items
    .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
    .sort(
      (a, b) =>
        (b.popularity || 0) - (a.popularity || 0) ||
        (b.vote_count || 0) - (a.vote_count || 0)
    );
}

async function fetchTMDBJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TMDB_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveFromTMDB(
  query: string,
  mode: TitleAliasMode
): Promise<string[]> {
  const config = await getConfig();
  const apiKey = config.SiteConfig.TMDBApiKey?.split(',')[0]?.trim();
  if (!apiKey) return [];

  const baseUrl =
    config.SiteConfig.TMDBReverseProxy || 'https://api.themoviedb.org';
  const cc = await getScriptConverters();
  const normalizedQuery = normalizeForMatch(query, cc);
  // TMDB 的检索不做简繁归一：简体查「高桥一生」搜不到日文原名「高橋一生」，
  // 因此原词与简繁变体都要各搜一次
  const queryVariants = Array.from(
    new Set([query, ...(cc ? [cc.t2s(query), cc.s2t(query)] : [])])
  );
  const searchLanguages = ['zh-TW', 'zh-HK', 'zh-CN'];
  const searchResults = await Promise.all(
    queryVariants.flatMap((variant) =>
      searchLanguages.map(async (language) => {
        const url = `${baseUrl}/3/search/multi?api_key=${encodeURIComponent(
          apiKey
        )}&language=${language}&query=${encodeURIComponent(variant)}&page=1`;
        // 单个变体/语言失败不拖垮整批检索
        const data = await fetchTMDBJson<TMDBSearchResponse>(url).catch(
          () => null
        );
        return data?.results || [];
      })
    )
  );

  const candidates = searchResults
    .flat()
    .map((item, index) => {
      const title = getTMDBTitle(item);
      const normalizedTitle = normalizeForMatch(title, cc);
      let score = 0;
      if (normalizedTitle === normalizedQuery) {
        score = item.media_type === 'person' ? 3 : 2;
      } else if (
        normalizedTitle &&
        item.media_type === 'person' &&
        normalizedQuery.includes(normalizedTitle)
      ) {
        score = 2;
      } else if (normalizedTitle.includes(normalizedQuery)) {
        score = 1;
      }
      return { item, index, score };
    })
    .filter((candidate) => candidate.score > 0);

  const selected = candidates.sort(
    (a, b) => b.score - a.score || a.index - b.index
  )[0]?.item;
  if (!selected?.id || !selected.media_type) {
    // 解析为空对用户表现为「搜不到」，留一行可观测：cc=false 代表 opencc 未载入，
    // results=0 代表检索全空/全失败，results>0 代表打分全不中
    console.warn('[TitleAlias] TMDB 未命中候选:', query, {
      cc: !!cc,
      variants: queryVariants.length,
      results: searchResults.flat().length,
    });
    return [];
  }

  if (selected.media_type === 'person') {
    if (mode !== 'person') return [];

    const url = `${baseUrl}/3/person/${
      selected.id
    }/combined_credits?api_key=${encodeURIComponent(apiKey)}&language=zh-CN`;
    const credits = await fetchTMDBJson<TMDBCombinedCreditsResponse>(url).catch(
      () => null
    );
    const names = [
      ...sortTMDBItemsByPopularity(selected.known_for || []).flatMap(
        getTMDBTitles
      ),
      ...sortTMDBItemsByPopularity([
        ...(credits?.cast || []),
        ...(credits?.crew || []),
      ]).flatMap(getTMDBTitles),
    ];
    return orderAliases(names, query, MAX_PERSON_ALIASES);
  }

  if (mode === 'person') return [];

  const detailLanguages = ['zh-CN', 'zh-TW', 'zh-HK'];
  const details = await Promise.all(
    detailLanguages.map(async (language) => {
      const url = `${baseUrl}/3/${selected.media_type}/${
        selected.id
      }?api_key=${encodeURIComponent(apiKey)}&language=${language}`;
      return fetchTMDBJson<TMDBDetailResponse>(url).catch(() => null);
    })
  );

  return orderAliases(
    [getTMDBTitle(selected), ...details.map(getTMDBTitle)],
    query
  );
}

async function resolveFromProviders(
  query: string,
  mode: TitleAliasMode
): Promise<string[]> {
  if (mode === 'person') {
    return withFallbackTimeout(
      resolveFromTMDB(query, 'person'),
      PERSON_RESOLVE_TIMEOUT,
      [] as string[]
    );
  }

  const [doubanAliases, tmdbAliases] = await Promise.all([
    withFallbackTimeout(
      resolveFromDouban(query),
      DOUBAN_TIMEOUT,
      [] as string[]
    ),
    withFallbackTimeout(
      resolveFromTMDB(query, 'title'),
      TMDB_TIMEOUT,
      [] as string[]
    ),
  ]);

  return orderAliases(
    [...tmdbAliases, ...getRegionalTitleAliases(query), ...doubanAliases],
    query
  );
}

async function resolveFromDouban(query: string): Promise<string[]> {
  // 1. 豆瓣搜索定位条目（subject_suggest 支持繁体输入与又名匹配）
  const suggests = await fetchDoubanData<DoubanSuggestItem[]>(
    `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`
  );
  if (!Array.isArray(suggests)) return [];
  // 建议首位是影人 => 查询词是人名：片名模式不猜测其作品，
  // 否则零分 fallback 会把「人名 -> 单部电影的又名」当成别名（人物请用演员/导演模式）
  if (suggests[0]?.type === 'celebrity') return [];
  const subjects = suggests
    .filter((item) => item.id && item.title && item.year)
    .slice(0, MAX_SUBJECT_CANDIDATES);
  if (subjects.length === 0) return [];

  // 2. 不只信第一个 suggest；取前几个候选详情，优先选择 title/aka 精确命中原词的条目。
  const cc = await getScriptConverters();
  const normalizedQuery = normalizeForMatch(query, cc);
  const candidates = (
    await Promise.all(
      subjects.map(async (subject, index) => {
        try {
          const detail = await fetchDoubanData<DoubanSubjectDetail>(
            `https://m.douban.com/rexxar/api/v2/subject/${subject.id}`
          );
          const names = [detail.title || subject.title, ...(detail.aka || [])]
            .filter((name): name is string => !!name)
            .map(cleanAliasName);
          const normalizedNames = names.map((name) =>
            normalizeForMatch(name, cc)
          );
          const score = normalizedNames.includes(normalizedQuery)
            ? 2
            : normalizedNames.some((name) => name.includes(normalizedQuery))
            ? 1
            : 0;
          return { index, names, score };
        } catch {
          return null;
        }
      })
    )
  ).filter((item): item is { index: number; names: string[]; score: number } =>
    Boolean(item)
  );

  const selected =
    candidates
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0] ||
    candidates[0];

  return selected ? orderAliases(selected.names, query) : [];
}

/**
 * 解析片名的跨地区别名，失败或超时返回空数组（不影响原始搜索）
 */
export async function resolveTitleAliases(
  query: string,
  mode: TitleAliasMode = 'title'
): Promise<string[]> {
  const key = query.trim();
  if (!key) return [];
  const cacheKey = `${mode}:${key}`;
  const cached = aliasCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.aliases;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const aliases = await Promise.race([
      resolveFromProviders(key, mode),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('alias resolve timeout')),
          // 外层兜底须大于人物模式的内层预算，否则内层等待变成必然超时
          mode === 'person' ? PERSON_RESOLVE_TIMEOUT + 500 : RESOLVE_TIMEOUT
        );
      }),
    ]);
    // 人物一定有作品，空结果视为解析失败（TMDB 超时/被挡），只短缓存以便尽快重试
    setAliasCache(
      cacheKey,
      aliases,
      mode === 'person' && aliases.length === 0
        ? ALIAS_NEGATIVE_TTL
        : ALIAS_CACHE_TTL
    );
    return aliases;
  } catch (error) {
    console.warn('[TitleAlias] 解析片名别名失败:', (error as Error).message);
    // 失败短缓存，避免豆瓣不可用时每次搜索都等满超时
    setAliasCache(cacheKey, [], ALIAS_NEGATIVE_TTL);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 用多个关键词（原词 + 别名）搜索同一资源站，并按 source+id 去重合并。
 * 关键词串行执行：避免与站点内部的多页并发相乘，瞬时打爆对方 CC 防护。
 * 传入 seen 可跨多次调用（分批渐进搜索）去重，只返回本批新增的结果。
 */
export async function searchFromApiWithQueries(
  apiSite: ApiSite,
  queries: string[],
  seen?: Set<string>
): Promise<SearchResult[]> {
  if (!seen && queries.length <= 1) {
    return searchFromApi(apiSite, queries[0]);
  }
  const dedupe = seen ?? new Set<string>();
  const merged: SearchResult[] = [];
  for (const q of queries) {
    const results = await searchFromApi(apiSite, q).catch(
      () => [] as SearchResult[]
    );
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      const dedupeKey = `${result.source}:${result.id}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);
      merged.push(result);
    }
  }
  return merged;
}
