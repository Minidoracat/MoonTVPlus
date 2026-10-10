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

export function getPreviousMangaChapter(
  chapters: MangaChapter[],
  chapterId: string
): MangaChapter | null {
  const ordered = orderMangaChapters(chapters);
  const index = ordered.findIndex((chapter) => chapter.id === chapterId);
  return index > 0 ? ordered[index - 1] : null;
}

/** 「第11卷」「第 3 冊」「Vol.2」「单行本」這類單行本名稱 */
const MANGA_VOLUME_NAME =
  /第\s*[\d零〇一二两三四五六七八九十百千]+\s*[卷冊册]|\bvol(?:ume)?\.?\s*\d|单行本|單行本/i;
/** 名稱同時寫了話數就是一般章節（「第11卷 第77話」「Vol.3 Ch.20」） */
const MANGA_CHAPTER_MARK = /[話话回章]|\bch(?:apter)?\.?\s*\d/i;

export function isMangaVolumeChapter(name: string): boolean {
  return MANGA_VOLUME_NAME.test(name) && !MANGA_CHAPTER_MARK.test(name);
}

/**
 * 有些來源把單行本夾在話中間（包子漫畫：第76話 → 第11卷 → 第77話）。正在看「話」、
 * 下一個是單行本、後面也還有話可以跳時，回傳要跳去的那一話，「下一話」先問要看哪個；
 * 其餘情況回 null 照舊直接進下一個（連著看單行本的人不必每卷都被問）。
 */
export function getMangaVolumeSkipTarget(
  chapters: MangaChapter[],
  chapterId: string
): MangaChapter | null {
  const ordered = orderMangaChapters(chapters);
  const index = ordered.findIndex((chapter) => chapter.id === chapterId);
  const next = ordered[index + 1];
  if (
    index < 0 ||
    !next ||
    isMangaVolumeChapter(ordered[index].name) ||
    !isMangaVolumeChapter(next.name)
  ) {
    return null;
  }
  return (
    ordered
      .slice(index + 2)
      .find((chapter) => !isMangaVolumeChapter(chapter.name)) ?? null
  );
}

/**
 * 這一話有讀到一半的紀錄（還沒到最後一頁）。詳情頁章節列表點它要接著讀 —— 那一列就寫著
 * 「上次看到第 N 页」；讀完的話與其他話照舊從第 1 頁開始，不會一點進去就跳到尾頁。
 */
export function isMangaChapterInProgress(
  record: MangaReadRecord | undefined,
  chapterId: string
): boolean {
  return Boolean(
    record &&
      record.chapterId === chapterId &&
      record.pageIndex < record.pageCount - 1
  );
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

/**
 * `startAt`：`first` 明確選章從第 1 頁；`last` 從上一話接著往回看，落在最後一頁；
 * `resume` 不帶參數，照閱讀紀錄續讀。網址沿用 `startPage=1`，舊連結照樣有效。
 */
export function buildMangaReadHref(input: {
  mangaId: string;
  sourceId: string;
  chapterId: string;
  title: string;
  cover: string;
  sourceName: string;
  chapterName: string;
  returnTo: string;
  startAt: 'first' | 'last' | 'resume';
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
    startAt,
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
  if (startAt !== 'resume') params.set('startPage', startAt === 'first' ? '1' : 'last');
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

/** 兩下點擊算雙擊的時間窗；圖片上的單擊也要等這麼久才切換控制列 */
export const MANGA_DOUBLE_TAP_MS = 300;

export interface MangaTapPoint {
  time: number;
  x: number;
  y: number;
}

/** 第二下常會偏一點，40px 內都算同一個位置 */
export function isMangaDoubleTap(
  previous: MangaTapPoint | null,
  next: MangaTapPoint
): boolean {
  return Boolean(
    previous &&
      next.time - previous.time <= MANGA_DOUBLE_TAP_MS &&
      Math.hypot(next.x - previous.x, next.y - previous.y) <= 40
  );
}

/** 放大圖的尺寸、在捲動內容裡的位置（比畫面小的那一軸置中）與初始捲動量 */
export interface MangaZoomLayout {
  width: number;
  height: number;
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * 雙擊放大的版面：放大後的圖尺寸、它在捲動內容裡的位置，以及讓點到的那一點
 * 留在手指下的初始捲動量。圖在某一軸比畫面小時那一軸置中、不能捲；靠邊時捲動量
 * 會被夾住，那一點就會偏離手指（不可能捲出圖外）。
 */
export function getMangaZoomLayout(input: {
  rect: { left: number; top: number; width: number; height: number };
  point: { x: number; y: number };
  viewport: { width: number; height: number };
  scale: number;
}): MangaZoomLayout {
  const { rect, point, viewport, scale } = input;
  const axis = (start: number, size: number, at: number, view: number) => {
    const zoomed = size * scale;
    const offset = Math.max((view - zoomed) / 2, 0);
    const ratio = Math.min(Math.max((at - start) / size, 0), 1);
    const maxScroll = Math.max(zoomed - view, 0);
    const scroll = Math.min(Math.max(offset + ratio * zoomed - at, 0), maxScroll);
    return { zoomed, offset, scroll };
  };
  const x = axis(rect.left, rect.width, point.x, viewport.width);
  const y = axis(rect.top, rect.height, point.y, viewport.height);
  return {
    width: x.zoomed,
    height: y.zoomed,
    left: x.offset,
    top: y.offset,
    scrollLeft: x.scroll,
    scrollTop: y.scroll,
  };
}
