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
