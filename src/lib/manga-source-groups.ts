import type { MangaSource } from '@/lib/manga.types';

export type MangaSourceCategoryId =
  | 'all'
  | 'recent'
  | 'safe'
  | 'mixed'
  | 'adult';

export interface MangaSourceCategory {
  id: MangaSourceCategoryId;
  label: string;
}

const RECENT_STORAGE_KEY = 'moontv_manga_recent_source_ids';
const RECENT_LIMIT = 8;

const ADULT_MARKERS = [
  '禁漫',
  '绅士',
  '紳士',
  '哔咔',
  '18漫',
  'cartoon18',
  'hanman',
  'hanime',
  'boylove',
  '香香腐宅',
  '肉漫',
  '一耽',
  '六漫画',
  '六漫畫',
  'picacomic',
  'wnacg',
  'jcomic',
  'noyacg',
  'toptoon',
  '頂通',
  '巴卡',
  'h-comic',
  'hcomic',
];

export function getMangaSourceLabel(source: MangaSource): string {
  return source.displayName || source.name || source.id;
}

export function getMangaSourceCategory(
  source: MangaSource
): Exclude<MangaSourceCategoryId, 'all' | 'recent'> {
  const text = `${source.name || ''} ${source.displayName || ''}`.toLowerCase();
  const adultByName = ADULT_MARKERS.some((marker) =>
    text.includes(marker.toLowerCase())
  );
  if (source.contentWarning === 'NSFW' || adultByName) return 'adult';
  if (source.contentWarning === 'SAFE') return 'safe';
  return 'mixed';
}

export function filterMangaSources(
  sources: MangaSource[],
  query: string
): MangaSource[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return sources;
  return sources.filter((source) =>
    `${source.name || ''} ${source.displayName || ''}`
      .toLowerCase()
      .includes(keyword)
  );
}

export function readRecentMangaSourceIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function rememberMangaSourceId(sourceId: string): string[] {
  if (!sourceId || typeof window === 'undefined') return [];
  const next = [
    sourceId,
    ...readRecentMangaSourceIds().filter((id) => id !== sourceId),
  ].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota: keep in-memory order only
  }
  return next;
}

export function getMangaSourceCategories(
  sources: MangaSource[],
  recentIds: string[]
): MangaSourceCategory[] {
  const recentCount = recentIds.filter((id) =>
    sources.some((source) => source.id === id)
  ).length;
  const safeCount = sources.filter(
    (source) => getMangaSourceCategory(source) === 'safe'
  ).length;
  const mixedCount = sources.filter(
    (source) => getMangaSourceCategory(source) === 'mixed'
  ).length;
  const adultCount = sources.filter(
    (source) => getMangaSourceCategory(source) === 'adult'
  ).length;

  const categories: MangaSourceCategory[] = [
    { id: 'all', label: `全部 ${sources.length}` },
  ];
  if (recentCount > 0) {
    categories.push({ id: 'recent', label: `常用 ${recentCount}` });
  }
  if (safeCount > 0) {
    categories.push({ id: 'safe', label: `一般 ${safeCount}` });
  }
  if (mixedCount > 0) {
    categories.push({ id: 'mixed', label: `混合 ${mixedCount}` });
  }
  if (adultCount > 0) {
    categories.push({ id: 'adult', label: `成人 ${adultCount}` });
  }
  return categories;
}

export function sourcesInCategory(
  sources: MangaSource[],
  category: MangaSourceCategoryId,
  recentIds: string[]
): MangaSource[] {
  if (category === 'all') return sources;
  if (category === 'recent') {
    const index = new Map(recentIds.map((id, i) => [id, i]));
    return sources
      .filter((source) => index.has(source.id))
      .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  }
  return sources.filter((source) => getMangaSourceCategory(source) === category);
}
