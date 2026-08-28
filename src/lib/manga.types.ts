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

/** GroupFilter 內的一個勾選項；position 是它在**群組內**的原始位置 */
export interface MangaFilterGroupOption {
  /**
   * 群組內原始 position。不可用「過濾後的索引」——群組內可能混有我們
   * 不支援的型別（Header 等），過濾後索引會錯位，送回 Suwayomi 就勾錯項。
   */
  position: number;
  name: string;
}

/**
 * 來源自帶的篩選項（分類／排序／地區等），由各來源外掛定義，沒有跨來源標準。
 *
 * `group` 是「分類多選」的實際形態：一組勾選框（實測 Komiic 的「類型」有
 * 71 項）。`checkbox` 是頂層單一勾選（例如 vomic 的開關）。
 * `group_select` 是**群組內的單選下拉**（實測喜漫的「分组标签」群組內是
 * 4 個 SelectFilter，各對應一種「类型」的標籤集）—— 對使用者呈現上就是
 * 一般下拉，只是提交時要走 groupChange。
 */
export type MangaSourceFilterOption =
  | {
      /** Suwayomi filter 在 filters 陣列中的位置，送回去時必填 */
      position: number;
      kind: 'select' | 'sort';
      name: string;
      values: string[];
    }
  | {
      /** 所屬群組在頂層 filters 陣列中的位置 */
      position: number;
      kind: 'group_select';
      /** 下拉自己在群組內的原始位置 */
      innerPosition: number;
      name: string;
      values: string[];
    }
  | {
      position: number;
      kind: 'group';
      name: string;
      options: MangaFilterGroupOption[];
    }
  | {
      position: number;
      kind: 'checkbox';
      name: string;
    };

/** 使用者選定的一個 filter 值 */
export type MangaFilterSelection =
  | {
      position: number;
      kind: 'select';
      /** values 的索引 */
      index: number;
    }
  | {
      position: number;
      kind: 'sort';
      index: number;
      ascending?: boolean;
    }
  | {
      position: number;
      kind: 'group_select';
      innerPosition: number;
      index: number;
    }
  | {
      position: number;
      kind: 'group';
      /** 勾選項在群組內的原始 position 清單（見 MangaFilterGroupOption） */
      positions: number[];
    }
  | {
      position: number;
      kind: 'checkbox';
      checked: boolean;
    };

/**
 * Suwayomi fetchSourceManga 的 FilterChangeInput（我們用到的子集）。
 *
 * groupChange 在真實 schema 是遞迴的 FilterChangeInput —— 已用 introspection
 * 確認並對喜漫實測 `groupChange: { position, selectState }` 生效。
 */
export interface SuwayomiFilterChange {
  position: number;
  selectState?: number;
  sortState?: { index: number; ascending: boolean };
  checkBoxState?: boolean;
  groupChange?: {
    position: number;
    checkBoxState?: boolean;
    selectState?: number;
  };
}

/**
 * 把使用者的選擇轉成 Suwayomi 的 FilterChangeInput 陣列。
 *
 * group 會**展開成多筆**：Suwayomi 的 groupChange 一筆只能改群組內一個
 * 勾選框，勾三個分類就是三筆。這也是這個函式存在的理由 —— 轉換不再是
 * 1:1 的 map，值得抽成純函式讓測試守著。
 */
export function buildFilterChangeInputs(
  selections: MangaFilterSelection[]
): SuwayomiFilterChange[] {
  return selections.flatMap((selection): SuwayomiFilterChange[] => {
    switch (selection.kind) {
      case 'sort':
        return [
          {
            position: selection.position,
            sortState: {
              index: selection.index,
              ascending: selection.ascending ?? false,
            },
          },
        ];
      case 'select':
        return [
          { position: selection.position, selectState: selection.index },
        ];
      case 'group_select':
        return [
          {
            position: selection.position,
            groupChange: {
              position: selection.innerPosition,
              selectState: selection.index,
            },
          },
        ];
      case 'checkbox':
        return [
          { position: selection.position, checkBoxState: selection.checked },
        ];
      case 'group':
        return selection.positions.map((inner) => ({
          position: selection.position,
          groupChange: { position: inner, checkBoxState: true },
        }));
    }
  });
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
  /**
   * 是否因為超過 per-source 上限才被歸為失敗。
   *
   * 必須和「來源真的壞了」分開：逾時只代表這一次太慢，來源本身可能完全健康，
   * 而健康度會保留 6 小時，把暫時的慢標成「失效」會誤導使用者去停用好來源。
   */
  timedOut?: boolean;
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
      /** true = 超過 per-source 上限；false = 來源自己回報錯誤 */
      timedOut: boolean;
    };

/**
 * 是否「每一個查詢的來源都失敗」。
 *
 * REST 與 SSE 兩條路徑都要回報這個旗標，前端據此把錯誤講成「全部來源都失敗」
 * 而不是「沒有找到漫畫」—— 兩者對使用者的意義完全不同（後者會讓人以為
 * 這個關鍵字沒有結果，而不是系統有問題）。
 *
 * 抽成單一函式而不是兩邊各寫一份判斷：先前就是各寫一份，任一邊寫錯都沒有
 * 東西會發現。
 *
 * 注意 `attempted > 0`：沒有任何來源可查時不算全滅（那是「沒有可用來源」，
 * 另一種狀況）；而來源成功但回 0 筆是合法的空結果，不能算失敗。
 */
export function isAllMangaSourcesFailed(
  attempted: number,
  failed: number
): boolean {
  return attempted > 0 && failed >= attempted;
}

/** 單一能力（熱門／搜尋）的探測結果 */
export interface MangaSourceProbeOutcome {
  ok: boolean;
  elapsedMs: number;
  /** 實際拿到幾筆；ok 但 count 為 0 代表來源可連但沒內容 */
  count: number;
  error?: string;
}

/**
 * 一個來源的完整探測結果。
 *
 * 熱門與搜尋分開記錄，因為它們會各自壞掉 —— 實測有來源熱門正常卻搜不到
 * （擴充套件沒實作搜尋），也有來源熱門逾時卻搜得到。合成單一顆燈會誤導。
 */
export interface MangaSourceProbe {
  popular: MangaSourceProbeOutcome;
  search: MangaSourceProbeOutcome;
}

/** 探測結果加上來源 id 與量測時間，即快取中的一筆 */
export interface MangaSourceProbeEntry extends MangaSourceProbe {
  sourceId: string;
  testedAt: number;
}

/**
 * 給一般使用者（選源面板）看的精簡探測摘要。
 *
 * 刻意**不含** error 欄位：完整錯誤訊息帶著上游的 Java stack trace，
 * 那是管理員診斷用的內部資訊，不該出現在面向使用者的端點。
 * 選源只需要「這顆能不能用、多快」。
 */
export interface MangaSourceProbeSummary {
  popularOk: boolean;
  popularMs: number;
  searchOk: boolean;
  searchMs: number;
  testedAt: number;
}

/** 把完整探測結果收斂成給使用者看的摘要 */
export function toMangaSourceProbeSummary(
  entry: MangaSourceProbeEntry
): MangaSourceProbeSummary {
  return {
    popularOk: entry.popular.ok,
    popularMs: entry.popular.elapsedMs,
    searchOk: entry.search.ok,
    searchMs: entry.search.elapsedMs,
    testedAt: entry.testedAt,
  };
}

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
