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

/**
 * 來源語言是否符合要求。**唯一的判斷來源。**
 *
 * 用前綴匹配而不是精確比對：Suwayomi 的來源標籤裡 `zh`、`zh-Hant`、`zh-Hans`
 * 是三個獨立值，精確比對會讓 `DefaultLang=zh` 把繁體與簡體來源整批排除 ——
 * 而那些來源既不參與預設搜尋，也不會出現在 `/api/manga/sources` 的清單，
 * 等於在 UI 上完全不可達。實測被排除的 6 顆裡有 2 顆真的有結果，其中
 * NoyAcg 是繁體來源（每次搜尋約 20 筆繁體標題）。
 *
 * 只放寬「更廣的查詢涵蓋更窄的標籤」這一個方向：
 *   `zh` 匹配 `zh` / `zh-Hant` / `zh-Hans`
 *   `zh` **不**匹配 `zhx`（必須是 `zh-` 開頭，不是任意 `zh` 開頭）
 *   `zh-Hant` 只匹配 `zh-Hant`（更精確的查詢不被放寬回 `zh`）
 *
 * 刻意不做大小寫正規化：那會需要同步改 getSources 的快取 key，
 * 是另一件事。目前上游回的標籤大小寫固定（`zh-Hant`）。
 */
export function matchesSourceLang(
  sourceLang: string | undefined,
  wanted: string | undefined
): boolean {
  if (!wanted) return true;
  if (!sourceLang) return false;
  return sourceLang === wanted || sourceLang.startsWith(`${wanted}-`);
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
 * 判斷既有的 selection 是否來自同一個 UI 控制項（因此該被新選擇取代）。
 *
 * **不能只比 position。** GroupFilter 會在同一個頂層 position 吐出多筆
 * group 與 group_select（見 getSourceFilters），只比 position 會讓使用者
 * 改一個控制項時，靜默清掉同一群組裡其他控制項已經選好的值。
 * group_select 還要再比 innerPosition —— 同一個群組內的多個下拉共用頂層
 * position，這是喜漫「分组标签」那 4 個下拉的形狀。
 *
 * select 與 sort 視為同一個控制項：一個頂層 filter 只會是其中一種，
 * 使用者看到的也是同一個下拉。
 */
export function isSameFilterControl(
  item: MangaFilterSelection,
  control: MangaSourceFilterOption
): boolean {
  if (item.position !== control.position) return false;
  switch (control.kind) {
    case 'select':
    case 'sort':
      return item.kind === 'select' || item.kind === 'sort';
    case 'group_select':
      return (
        item.kind === 'group_select' &&
        item.innerPosition === control.innerPosition
      );
    case 'group':
      return item.kind === 'group';
    case 'checkbox':
      return item.kind === 'checkbox';
  }
}

/**
 * 把控制項／選擇的識別鍵格式化成可讀字串，只給錯誤訊息用。
 *
 * **一定要含 innerPosition。** group_select 是唯一有第三個識別鍵的 kind，
 * 而「control 是 inner 0、next 抄成 inner 3」正是最可能的不一致；少了它，
 * 兩邊會印成完全相同的 `kind=group_select position=7`，讀 log 的人無從
 * 判斷哪裡不符。production 的 console.error 是那條路徑唯一的訊號。
 */
function formatFilterIdentity(
  target: MangaSourceFilterOption | MangaFilterSelection
): string {
  const inner =
    'innerPosition' in target ? ` innerPosition=${target.innerPosition}` : '';
  return `kind=${target.kind} position=${target.position}${inner}`;
}

/**
 * 把某個控制項的新選擇寫進 selections，同時移除該控制項的舊選擇。
 *
 * `next` 為 `null` 代表這個控制項回到未選狀態（下拉選了空白、checkbox 取消
 * 勾選、群組 chip 全部取消）—— 那就只移除舊值、不加新值。刻意不送「空選擇」
 * 給上游：`{ checked: false }` 或空 positions 與「使用者沒有選」在來源端是
 * 不同語意。
 *
 * 五處 UI 控制項共用這一個函式，是為了讓 rest 過濾的規則只有一份實作。
 * 先前每處各自手寫 `prev.filter(...)`，抽出判斷式後外殼仍是五份複製，
 * 於是任何一處退化成「只比 position」都不會有測試失敗（實測驗證過）。
 */
export function upsertFilterSelection(
  prev: MangaFilterSelection[],
  control: MangaSourceFilterOption,
  next: MangaFilterSelection | null
): MangaFilterSelection[] {
  if (next && !isSameFilterControl(next, control)) {
    const message =
      'upsertFilterSelection: next 不屬於 control' +
      `（control ${formatFilterIdentity(control)}` +
      `, next ${formatFilterIdentity(next)}）`;
    /*
     * next 的識別鍵（position / kind / innerPosition）必須指向 control 自己。
     * 不一致時舊值會被移除、新值掛到另一個識別鍵上：畫面顯示這個控制項未選，
     * 上游卻收到一筆多餘條件 —— 識別鍵都只是 number，型別擋不住。
     *
     * 開發期直接丟出來。**production 刻意不丟**：五處呼叫點都在
     * `setFilterSelections((prev) => ...)` 的 updater 內，例外會往上拋成
     * render 期錯誤，而這一頁沒有 error boundary —— 結果是整頁白畫面。
     * 把「一個 filter 掛錯位置」升級成「整頁不可用」是更差的失效模式。
     *
     * 這個檢查也只可能被「日後新增的呼叫點寫錯」觸發，而那條路徑不會有
     * 單元測試覆蓋（測試碰不到元件的接線，第 11 輪實測證實過），所以它
     * 不會在 CI 爆、只會在真實使用者面前爆。
     *
     * production 改為記錄並**拒絕這次寫入**（回傳原本的 prev，同一個引用，
     * React 會跳過 re-render）。使用者會看到「點了沒反應」——那是可察覺的
     * 失敗；照常寫入則會把錯誤條件靜默送給上游，畫面與結果不符卻沒有任何
     * 線索，那正是這個函式被抽出來要防的事。
     */
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(message);
    }
    console.error(message);
    return prev;
  }
  const rest = prev.filter((item) => !isSameFilterControl(item, control));
  return next ? [...rest, next] : rest;
}

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
  /**
   * 群組內單一子項的變更。checkBoxState 與 selectState 互斥、且必須恰好給一個 ——
   * 用 union 而非兩個各自 optional 的欄位，「都不給」與「都給」才無法編譯，
   * 不會靜默送出上游無從解讀的請求。
   */
  groupChange?: { position: number } & (
    | { checkBoxState: boolean; selectState?: never }
    | { selectState: number; checkBoxState?: never }
  );
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
        return [{ position: selection.position, selectState: selection.index }];
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
  latestChapterCount?: number;
  latestChapterName?: string;
}

export interface MangaSearchFailure {
  sourceId: string;
  sourceName: string;
  error: string;
  /**
   * 這顆來源是「超過 per-source deadline 被砍」還是「真的壞了」。
   *
   * 兩者對使用者的意義不同：超時多半是暫時變慢（下次可能就好），
   * 來源故障則是持續性的。前端的失敗橫幅要能分辨，所以這個欄位是**必填**
   * —— 先前只有 SSE 路徑送出它，`searchManga` 明明手上就有 `outcome.timedOut`
   * 卻沒帶進來，而型別沒宣告這個欄位，於是前端讀到的永遠是 undefined，
   * 「含 N 个超时」恆為 0 而 tsc 全綠。
   */
  timedOut: boolean;
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

declare const sourceExternalUrlBrand: unique symbol;
/** 已驗證為絕對 http(s) 的來源站外連 URL */
export type SourceExternalUrl = string & {
  readonly [sourceExternalUrlBrand]: true;
};

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
  /** 來源站章節頁；只接受伺服器清理過的絕對 http(s) URL */
  realUrl?: SourceExternalUrl;
}

export interface MangaDetail extends MangaSearchItem {
  chapters: MangaChapter[];
  /**
   * 來源站上這部漫畫的原始頁面網址（Suwayomi 的 `manga.realUrl`）。
   *
   * 用來把使用者導到來源站看留言：留言不在 Suwayomi 裡，只有來源站有。
   * 只有在伺服器確實回了絕對 http(s) 網址時才有值 —— 用 sourceId 與標題
   * 猜出來的網址會把人送到不存在或不相干的頁面，寧可不給連結。
   */
  realUrl?: SourceExternalUrl;
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
  /** 最近一次检测到新章节的时间 */
  updateTime?: number;
  favorite?: boolean;
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
