import type {
  MangaChapter,
  MangaDetail,
  MangaReadRecord,
  MangaShelfItem,
} from '@/lib/manga.types';

/**
 * 章節的唯一排序規則，章節列表與「下一話」必須共用，否則兩邊會漂移。
 *
 * Suwayomi 回的清單本來就是來源順序（舊到新），比話數可靠：沒話數的特別篇、請假條
 * （chapterNumber -1）照話數排會全擠到第 1 話之前（武炼巅峰有 195 話），名稱尾端的數字
 * 還會被誤判成話數（「大决战篇-混沌灵王 2」被當成第 2 話）。所以清單大致有序就照它，
 * 只依有話數的章節判斷是舊到新還是新到舊；真的亂序才退回話數 → uploadDate → id。
 */
export function orderMangaChapters(chapters: MangaChapter[]): MangaChapter[] {
  let rises = 0;
  let falls = 0;
  let previous: number | null = null;
  for (const chapter of chapters) {
    const chapterNo = chapter.chapterNumber;
    if (typeof chapterNo !== 'number' || chapterNo < 0) continue;
    if (previous !== null && chapterNo > previous) rises++;
    if (previous !== null && chapterNo < previous) falls++;
    previous = chapterNo;
  }
  // ponytail: 逆向不超過一成就當作有序；來源亂序又剛好接近一成時才會選錯
  if (Math.min(rises, falls) * 10 <= rises + falls) {
    return falls > rises ? [...chapters].reverse() : [...chapters];
  }
  return [...chapters].sort((a, b) => {
    const numberDiff = (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0);
    if (numberDiff !== 0) return numberDiff;
    const dateDiff = (a.uploadDate ?? 0) - (b.uploadDate ?? 0);
    if (dateDiff !== 0) return dateDiff;
    return a.id.localeCompare(b.id);
  });
}

export function getNextMangaChapter(
  chapters: MangaChapter[],
  chapterId: string
): MangaChapter | null {
  const ordered = orderMangaChapters(chapters);
  const index = ordered.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0 || index >= ordered.length - 1) return null;
  return ordered[index + 1];
}

const CHAPTER_ORDER_STORAGE_KEY = 'moontv_manga_chapter_order';

/** 章節列表要不要最新在前（詳情頁與閱讀器共用）；預設最早在前，從第一話往下看 */
export function readMangaChapterNewestFirst(): boolean {
  try {
    return window.localStorage.getItem(CHAPTER_ORDER_STORAGE_KEY) === 'newest';
  } catch {
    return false;
  }
}

export function saveMangaChapterNewestFirst(newestFirst: boolean): void {
  try {
    window.localStorage.setItem(
      CHAPTER_ORDER_STORAGE_KEY,
      newestFirst ? 'newest' : 'oldest'
    );
  } catch {
    // private mode / quota：只在這次頁面生效
  }
}

/**
 * 決定載入章節後的起始頁。
 *
 * `forceFirstPage` 只由使用者明確選話／點下一話時帶入。那個意圖優先於歷史
 * 紀錄；否則右上章節選單選一話，剛好該話以前讀到尾頁時就會直接跳到最後。
 * 一般從書架／歷史進來仍照原本紀錄續讀。
 */
export function getReaderStartPage(input: {
  forceFirstPage: boolean;
  record: MangaReadRecord | undefined;
  chapterId: string;
  pageCount: number;
}): number {
  const { forceFirstPage, record, chapterId, pageCount } = input;
  if (forceFirstPage || !record || record.chapterId !== chapterId) return 0;
  return Math.min(
    Math.max(record.pageIndex || 0, 0),
    Math.max(pageCount - 1, 0)
  );
}

export function getHorizontalPageStride(
  viewportWidth: number,
  pageGap: number
): number {
  return Math.max(viewportWidth + pageGap, 1);
}

export function getHorizontalPageOffset(
  page: number,
  viewportWidth: number,
  pageGap: number
): number {
  return Math.max(page, 0) * getHorizontalPageStride(viewportWidth, pageGap);
}

export function getHorizontalPageIndex(
  scrollLeft: number,
  viewportWidth: number,
  pageGap: number,
  pageCount: number
): number {
  if (pageCount <= 0) return 0;
  const page = Math.round(
    Math.max(scrollLeft, 0) / getHorizontalPageStride(viewportWidth, pageGap)
  );
  return Math.min(page, pageCount - 1);
}

export function getReaderProgress(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  const clamped = Math.min(Math.max(page, 0), pageCount - 1);
  return Math.round(((clamped + 1) / pageCount) * 100);
}

export function buildMangaReadHref(input: {
  mangaId: string;
  sourceId: string;
  chapterId: string;
  title: string;
  cover: string;
  sourceName: string;
  chapterName: string;
  returnTo: string;
  startAtFirstPage: boolean;
}): string {
  const {
    mangaId,
    sourceId,
    chapterId,
    title,
    cover,
    sourceName,
    chapterName,
    returnTo,
    startAtFirstPage,
  } = input;
  const params = new URLSearchParams({
    mangaId,
    sourceId,
    chapterId,
    title,
    cover,
    sourceName,
    chapterName,
    returnTo,
  });
  if (startAtFirstPage) params.set('startPage', '1');
  return `/manga/read?${params.toString()}`;
}

/**
 * 詳情頁網址一律走這裡（和 buildMangaReadHref 一樣用 URLSearchParams）。Next 14 的預取快取
 * key 會把查詢字串重新序列化（空白 → +、括號 → %28），用 encodeURIComponent 拼的網址永遠
 * 對不上：預取全部白做，點下去要等伺服器完整回應才換頁，loading.tsx 也出不來。
 */
export function buildMangaDetailHref(input: {
  mangaId: string;
  sourceId: string;
  title?: string;
  cover?: string;
  sourceName?: string;
  description?: string;
  author?: string;
  status?: string;
  returnTo?: string;
}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value) params.set(key, value);
  }
  return `/manga/detail?${params.toString()}`;
}

export function buildMangaAlternateSearchHref(title: string): string {
  const params = new URLSearchParams({ q: title.trim() });
  return `/manga/search?${params.toString()}`;
}

export function buildMangaShelfItem(input: {
  detail: MangaDetail;
  currentChapter?: Pick<MangaChapter, 'id' | 'name'>;
  unreadChapterCount?: number;
  saveTime?: number;
}): MangaShelfItem {
  const {
    detail,
    currentChapter,
    unreadChapterCount = 0,
    saveTime = Date.now(),
  } = input;
  const chapters = orderMangaChapters(detail.chapters || []);
  const latestChapter = chapters[chapters.length - 1];
  return {
    title: detail.title,
    cover: detail.cover,
    sourceId: detail.sourceId,
    sourceName: detail.sourceName,
    mangaId: detail.id,
    saveTime,
    description: detail.description,
    author: detail.author,
    status: detail.status,
    lastChapterId: currentChapter?.id,
    lastChapterName: currentChapter?.name,
    latestChapterId: latestChapter?.id,
    latestChapterName: latestChapter?.name,
    latestChapterCount: chapters.length,
    unreadChapterCount,
  };
}

/** vertical restore 僅 eager target 附近，避免 0..target 線性下載。 */
export function shouldEagerLoadVerticalRestorePage(
  index: number,
  target: number,
  preloadPageCount: number
): boolean {
  if (index < 0 || target < 0) return false;
  const preload = Math.max(preloadPageCount, 0);
  return index >= Math.max(target - 1, 0) && index <= target + preload;
}

export function isVerticalRestoreWindowSettled(
  settledPages: ReadonlySet<number>,
  target: number
): boolean {
  if (target < 0) return false;
  for (let page = Math.max(target - 1, 0); page <= target; page += 1) {
    if (!settledPages.has(page)) return false;
  }
  return true;
}
