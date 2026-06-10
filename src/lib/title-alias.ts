/* eslint-disable no-console */

/**
 * 三地片名别名搜索（服务端）
 *
 * 通过豆瓣定位条目并读取「又名」，将用户输入的任一地区译名
 * （如台湾「刺激1995」/ 香港「月黑高飞」/ 大陆「肖申克的救赎」）
 * 扩展为多个关键词一并搜索资源站。解析失败或超时自动降级为仅用原词搜索。
 */

import { ApiSite } from '@/lib/config';
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

const aliasCache = new Map<string, { aliases: string[]; expires: number }>();
const ALIAS_CACHE_TTL = 24 * 60 * 60 * 1000; // 别名几乎不变，缓存 24 小时
const ALIAS_NEGATIVE_TTL = 5 * 60 * 1000; // 解析失败短缓存，避免豆瓣被挡时反复重试拖慢搜索
const ALIAS_CACHE_MAX = 500;
const MAX_ALIASES = 3;
const RESOLVE_TIMEOUT = 4000;

const CJK_REGEX = /[一-鿿]/;

function setAliasCache(key: string, aliases: string[], ttl = ALIAS_CACHE_TTL) {
  if (aliasCache.size >= ALIAS_CACHE_MAX) {
    const oldest = aliasCache.keys().next().value;
    if (oldest !== undefined) aliasCache.delete(oldest);
  }
  aliasCache.set(key, { aliases, expires: Date.now() + ttl });
}

async function resolveFromDouban(query: string): Promise<string[]> {
  // 1. 豆瓣搜索定位条目（subject_suggest 支持繁体输入与又名匹配）
  const suggests = await fetchDoubanData<DoubanSuggestItem[]>(
    `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`
  );
  const subject = Array.isArray(suggests)
    ? suggests.find((item) => item.id && item.title && item.year)
    : undefined;
  if (!subject) return [];

  // 2. 条目详情的 title + aka 含各地译名（如「刺激1995(台)」「月黑高飞(港)」）
  const detail = await fetchDoubanData<DoubanSubjectDetail>(
    `https://m.douban.com/rexxar/api/v2/subject/${subject.id}`
  );
  const names = [detail.title, ...(detail.aka || [])]
    .filter((name): name is string => !!name)
    .map((name) => name.replace(/[（(]\s*[港台澳]\s*[)）]\s*$/, '').trim())
    .filter((name) => name && name !== query);

  // 中文片名优先：资源站基本以中文片名收录
  const ordered = [
    ...names.filter((name) => CJK_REGEX.test(name)),
    ...names.filter((name) => !CJK_REGEX.test(name)),
  ];
  return Array.from(new Set(ordered)).slice(0, MAX_ALIASES);
}

/**
 * 解析片名的跨地区别名，失败或超时返回空数组（不影响原始搜索）
 */
export async function resolveTitleAliases(query: string): Promise<string[]> {
  const key = query.trim();
  if (!key) return [];
  const cached = aliasCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.aliases;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const aliases = await Promise.race([
      resolveFromDouban(key),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('alias resolve timeout')),
          RESOLVE_TIMEOUT
        );
      }),
    ]);
    setAliasCache(key, aliases);
    return aliases;
  } catch (error) {
    console.warn('[TitleAlias] 解析片名别名失败:', (error as Error).message);
    // 失败短缓存，避免豆瓣不可用时每次搜索都等满超时
    setAliasCache(key, [], ALIAS_NEGATIVE_TTL);
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
