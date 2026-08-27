/**
 * 「全部停用」用的白名單哨兵值。
 *
 * `SourceIds: []` 在全站語意是「不限制＝全開」，所以全停時不能寫回空陣列，
 * 否則管理員按「全部停用」會得到「全部開放」。改寫一個不可能對到任何來源的
 * 值，白名單過濾後自然是空清單＝全部拒絕。
 * Suwayomi 的 source id 是數字字串，不會與這個值相撞。
 *
 * 定義在這裡讓 admin route（寫入端）與 suwayomi.client（讀取端）共用同一份，
 * 避免兩邊各寫一個字面值而漂移。
 */
export const MANGA_DISABLE_ALL_SENTINEL = '__none__';

/**
 * 某來源是否被允許。**唯一的判斷來源**。
 *
 * 語意：（白名單為空 或 id ∈ 白名單）且 id ∉ 黑名單。
 * 黑名單先判，讓「明確停用」永遠勝過「白名單包含」。
 *
 * 寫入端（admin 面板顯示 enabled）與讀取端（fetchSources 過濾）必須用同一份，
 * 否則只改一邊就會出現「面板顯示已停用、使用者卻仍讀得到」——
 * 那是這套機制最惡的失效模式。
 */
export function isMangaSourceAllowed(
  id: string,
  allowList: readonly string[],
  blockList: readonly string[]
): boolean {
  if (blockList.includes(id)) return false;
  if (allowList.length > 0 && !allowList.includes(id)) return false;
  return true;
}

export type MangaContentWarning = 'SAFE' | 'MIXED' | 'NSFW';

export interface MangaSource {
  id: string;
  name: string;
  lang?: string;
  displayName?: string;
  contentWarning?: MangaContentWarning;
}

/** 來源自帶的篩選項（分類／排序／地區等），由各來源外掛定義，沒有跨來源標準 */
export interface MangaSourceFilterOption {
  /** Suwayomi filter 在 filters 陣列中的位置，送回去時必填 */
  position: number;
  kind: 'select' | 'sort';
  name: string;
  values: string[];
}

/** 使用者選定的一個 filter 值 */
export interface MangaFilterSelection {
  position: number;
  kind: 'select' | 'sort';
  /** values 的索引 */
  index: number;
  /** sort 專用；select 忽略 */
  ascending?: boolean;
}

export interface MangaSearchItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  cover: string;
  description?: string;
  author?: string;
  status?: string;
  artist?: string;
  genre?: string;
}

export interface MangaSearchFailure {
  sourceId: string;
  sourceName: string;
  error: string;
}

export interface MangaSourceMeasurement {
  sourceId: string;
  elapsedMs: number;
  failed: boolean;
}

export interface MangaSearchResult {
  results: MangaSearchItem[];
  failedSources: MangaSearchFailure[];
  /** 實際查詢的來源數；`results` 是攤平的漫畫項目，不能用來推算來源數 */
  attemptedSources: number;
  /** 每個來源的耗時／成敗，供前端累積來源健康度（非流式路徑也要有） */
  measurements: MangaSourceMeasurement[];
}

/** 單一搜尋來源的識別資訊（fan-out 過程中需要回報是哪一顆） */
export interface MangaSearchSourceRef {
  id: string;
  displayName?: string;
  name?: string;
}

/**
 * 單一來源一次搜尋的原始回傳（尚未套 per-source 上限，會 reject）。
 *
 * 帶回 source 是因為 fan-out 是併發的，呼叫端要能認出這筆是哪一顆來源的。
 */
export interface MangaSourceSearchResponse {
  source: MangaSearchSourceRef;
  results: MangaSearchItem[];
}

/**
 * 單一來源的搜尋結果，帶 per-source 上限後永不 reject。
 *
 * 用 status 判別而非「results 空陣列 + 另一個 error 欄位」：後者無法區分
 * 「這顆來源真的沒有結果」與「這顆來源失敗了」，而 UI 必須分開顯示 ——
 * 全部來源失敗時不能講成「沒有找到漫畫」。
 */
export type MangaSourceSearchOutcome =
  | {
      status: 'ok';
      source: MangaSearchSourceRef;
      sourceName: string;
      results: MangaSearchItem[];
      elapsedMs: number;
    }
  | {
      status: 'failed';
      source: MangaSearchSourceRef;
      sourceName: string;
      error: string;
      elapsedMs: number;
    };

export type MangaRecommendType = 'POPULAR' | 'LATEST';

export interface MangaRecommendResult {
  mangas: MangaSearchItem[];
  hasNextPage: boolean;
}

export interface MangaChapter {
  id: string;
  mangaId: string;
  name: string;
  chapterNumber?: number;
  scanlator?: string;
  isRead?: boolean;
  isDownloaded?: boolean;
  pageCount?: number;
  uploadDate?: number;
}

export interface MangaDetail extends MangaSearchItem {
  chapters: MangaChapter[];
}

export interface MangaShelfItem {
  title: string;
  cover: string;
  sourceId: string;
  sourceName: string;
  mangaId: string;
  saveTime: number;
  description?: string;
  author?: string;
  status?: string;
  lastChapterId?: string;
  lastChapterName?: string;
  latestChapterId?: string;
  latestChapterName?: string;
  latestChapterCount?: number;
  unreadChapterCount?: number;
}

export interface MangaReadRecord {
  title: string;
  cover: string;
  sourceId: string;
  sourceName: string;
  mangaId: string;
  chapterId: string;
  chapterName: string;
  pageIndex: number;
  pageCount: number;
  saveTime: number;
}
