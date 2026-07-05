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
const MAX_SUBJECT_CANDIDATES = 6;
const RESOLVE_TIMEOUT = 4500;
const DOUBAN_TIMEOUT = 3500;
const TMDB_TIMEOUT = 2500;

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

function orderAliases(names: string[], query: string): string[] {
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
  ].slice(0, MAX_ALIASES);
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
  const normalizedQuery = normalizeAliasName(query);
  const searchLanguages = ['zh-TW', 'zh-HK', 'zh-CN'];
  const searchResults = await Promise.all(
    searchLanguages.map(async (language) => {
      const url = `${baseUrl}/3/search/multi?api_key=${encodeURIComponent(
        apiKey
      )}&language=${language}&query=${encodeURIComponent(query)}&page=1`;
      const data = await fetchTMDBJson<TMDBSearchResponse>(url);
      return data.results || [];
    })
  );

  const candidates = searchResults
    .flat()
    .map((item, index) => {
      const title = getTMDBTitle(item);
      const normalizedTitle = normalizeAliasName(title);
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
  if (!selected?.id || !selected.media_type) return [];

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
    return orderAliases(names, query);
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
      TMDB_TIMEOUT,
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
  const subjects = Array.isArray(suggests)
    ? suggests
        .filter((item) => item.id && item.title && item.year)
        .slice(0, MAX_SUBJECT_CANDIDATES)
    : [];
  if (subjects.length === 0) return [];

  // 2. 不只信第一个 suggest；取前几个候选详情，优先选择 title/aka 精确命中原词的条目。
  const normalizedQuery = normalizeAliasName(query);
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
          const normalizedNames = names.map(normalizeAliasName);
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
          RESOLVE_TIMEOUT
        );
      }),
    ]);
    setAliasCache(cacheKey, aliases);
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
 */
export async function searchFromApiWithQueries(
  apiSite: ApiSite,
  queries: string[]
): Promise<SearchResult[]> {
  if (queries.length <= 1) {
    return searchFromApi(apiSite, queries[0]);
  }
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const q of queries) {
    const results = await searchFromApi(apiSite, q).catch(
      () => [] as SearchResult[]
    );
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      const dedupeKey = `${result.source}:${result.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(result);
    }
  }
  return merged;
}
