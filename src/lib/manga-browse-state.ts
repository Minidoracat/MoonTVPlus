import type { MangaFilterSelection, MangaSearchItem } from './manga.types';
import { parseMangaFilterSelections } from './manga-filter-params';

export const MANGA_BROWSE_STATE_KEY = 'manga_browse_state';

export interface MangaBrowseState {
  listHref: string;
  keyword: string;
  filterSelections: MangaFilterSelection[];
  page: number;
  mangas: MangaSearchItem[];
  hasNextPage: boolean;
  scrollY: number;
  savedAt: number;
}

export function parseMangaBrowseState(raw: string): MangaBrowseState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MangaBrowseState> | null;
    const filterSelections = parsed && Array.isArray(parsed.filterSelections)
      ? parseMangaFilterSelections(JSON.stringify(parsed.filterSelections))
      : null;
    if (
      !parsed ||
      typeof parsed.listHref !== 'string' ||
      typeof parsed.keyword !== 'string' ||
      !filterSelections ||
      typeof parsed.page !== 'number' ||
      !Number.isInteger(parsed.page) ||
      parsed.page < 1 ||
      !Array.isArray(parsed.mangas) ||
      parsed.mangas.length > 300 ||
      !parsed.mangas.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.sourceId === 'string' &&
          typeof item.sourceName === 'string' &&
          typeof item.title === 'string' &&
          typeof item.cover === 'string'
      ) ||
      typeof parsed.hasNextPage !== 'boolean' ||
      typeof parsed.scrollY !== 'number' ||
      !Number.isFinite(parsed.scrollY) ||
      parsed.scrollY < 0 ||
      typeof parsed.savedAt !== 'number' ||
      !Number.isFinite(parsed.savedAt) ||
      Date.now() - parsed.savedAt > 10 * 60_000
    ) {
      return null;
    }
    return { ...parsed, filterSelections } as MangaBrowseState;
  } catch {
    return null;
  }
}

/**
 * 把下一頁接到清單後面並丟掉已出現過的作品 —— 上游分頁常互相重疊（GoDa 實測
 * 第 2、3 頁會重送第 1 頁的作品），直接 concat 會出現重複卡片與重複的 React key。
 * `added` 是真正新增的數量：一整頁都重複代表來源在重送同一批，呼叫端據此停止翻頁。
 */
export function appendUniqueMangas(
  existing: MangaSearchItem[],
  incoming: MangaSearchItem[]
): { mangas: MangaSearchItem[]; added: number } {
  const seen = new Set(existing.map((item) => `${item.sourceId}+${item.id}`));
  const fresh = incoming.filter((item) => {
    const key = `${item.sourceId}+${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { mangas: [...existing, ...fresh], added: fresh.length };
}
