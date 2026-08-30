import type {
  MangaChapter,
  MangaDetail,
  MangaReadRecord,
  MangaShelfItem,
} from '@/lib/manga.types';

/** 章節的唯一排序規則，章節列表與「下一話」必須共用，否則兩邊會漂移。 */
export function orderMangaChapters(chapters: MangaChapter[]): MangaChapter[] {
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
