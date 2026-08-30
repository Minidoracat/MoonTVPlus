import type {
  MangaSearchItem,
  MangaSourceProbeSummary,
} from '@/lib/manga.types';
import { MAX_KEYWORD_LENGTH } from '@/lib/manga-search-params';
import type { MangaSourceHealth } from '@/lib/manga-source-health';

/**
 * 搜尋結果的顯示邏輯：分桶、篩選＋排序、分組。
 *
 * 這三個函式原本是 `/manga/search` 頁面裡的三個 useMemo。抽出來的理由和
 * `isSameFilterControl`／`upsertFilterSelection` 一樣：它們是純函式（輸入
 * 只有結果陣列與幾個顯示選項，輸出只有陣列），而它們守的不變式全都會
 * **靜默失敗** —— 退化了畫面仍然畫得出東西，只是順序不對、篩選沒套上，
 * 或悄悄改到 React state。這一輪的兩個 important 就是靠人眼推演才發現的。
 */

/** 結果的排列方式。arrival 是既有行為：誰先回應誰在前。 */
export type MangaResultSort = 'arrival' | 'source' | 'title';

export interface MangaSourceBucket {
  sourceId: string;
  sourceName: string;
  count: number;
}

export interface MangaSourceGroup extends MangaSourceBucket {
  /** 可是 render 窗口子集；繼承的 count 仍是來源 bucket 的完整筆數 */
  items: MangaSearchItem[];
}

export type MangaCreatorRole = 'author' | 'artist';

export interface MangaCreatorFilter {
  sourceId: string;
  name: string;
  /** 舊 URL 沒有 role 時相容：undefined 代表 author/artist 兩欄都比 */
  role?: MangaCreatorRole;
}

export interface MangaCreatorGroup {
  role: MangaCreatorRole;
  /** 原始碼 user-facing copy 沿用既有簡體慣例；繁體由 UI 轉換層處理 */
  label: '作者' | '绘师';
  creators: string[];
}

/** 不具可搜尋意義的上游佔位值，不渲染成 creator 按鈕 */
const IGNORED_CREATORS = new Set([
  'n/a',
  'unknown',
  '未知',
  '佚名',
  '无',
  '無',
  '-',
  'ai',
]);

/**
 * 拆一個 author/artist 欄位；唯一特殊情況是把獨立的 N/A 保持成一塊。
 * 不按空白拆：`BRAVE HEART petit`、韓文／英文作者名本身會有空白。
 */
function splitCreatorField(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value) parts.push(value);
    current = '';
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === ',' || char === '，' || char === '、' || char === '&') {
      flush();
      continue;
    }
    if (char === '/') {
      /*
       * 只有「這一段目前正好是 N」且右側是「A + delimiter/end」才是 N/A。
       * X/A社、X/A&B、Lyco./KARAi、mg_cls/白 都會走 flush，正常拆分。
       * 未知 / N/A 的第一個 slash 拆分未知，第二個 slash 才保護 N/A。
       *
       * 不用 raw.slice(index + 1)：逐 slash 配置剩餘字串在長髒資料下會退化成
       * O(n × slash 數)。索引往右跳空白與 A，不建立 substring。
       */
      let rightIndex = index + 1;
      while (rightIndex < raw.length && /\s/.test(raw[rightIndex])) {
        rightIndex += 1;
      }
      const rightIsA = raw[rightIndex]?.toLowerCase() === 'a';
      let afterA = rightIndex + 1;
      while (afterA < raw.length && /\s/.test(raw[afterA])) {
        afterA += 1;
      }
      const rightEndsToken =
        afterA >= raw.length || ',，、&/'.includes(raw[afterA]);
      const isNa =
        current.trim().toLowerCase() === 'n' && rightIsA && rightEndsToken;
      if (isNa) {
        current += char;
      } else {
        flush();
      }
      continue;
    }
    current += char;
  }
  flush();
  return parts;
}

/** 解析單一 author 或 artist 欄位，保留欄位角色、不在這裡混合兩者 */
function getCreatorsFromField(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const creators: string[] = [];
  for (const part of splitCreatorField(raw.trim())) {
    const name = part.trim();
    const normalized = name.toLowerCase();
    // ignore 查表移除空白，讓 scanner 保護下來的 `N / A`／`N /A`／`N/ A`
    // 仍命中 n/a；dedupe key 刻意保留空白，合法名稱 `A B` 與 `AB`
    // 不應該被合併。
    const ignoredKey = name.replace(/\s+/g, '').toLowerCase();
    if (
      !name ||
      name.length > MAX_KEYWORD_LENGTH ||
      IGNORED_CREATORS.has(ignoredKey) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    creators.push(name);
  }
  return creators;
}

/**
 * 依 Suwayomi 欄位語意分開回傳：author 是「作者」，artist 是「绘师」。
 * 上游沒有 uploader 欄位，所以 UI 不再把 author 模糊標成「作者／上传者」。
 */
export function getMangaCreatorGroups(
  item: MangaSearchItem
): MangaCreatorGroup[] {
  const groups: MangaCreatorGroup[] = [];
  const authors = getCreatorsFromField(item.author);
  const artists = getCreatorsFromField(item.artist);
  if (authors.length > 0) {
    groups.push({ role: 'author', label: '作者', creators: authors });
  }
  if (artists.length > 0) {
    groups.push({ role: 'artist', label: '绘师', creators: artists });
  }
  return groups;
}

/** 相容舊呼叫端：合併 author/artist 並跨欄位去重 */
export function getMangaCreators(item: MangaSearchItem): string[] {
  const seen = new Set<string>();
  const creators: string[] = [];
  for (const group of getMangaCreatorGroups(item)) {
    for (const name of group.creators) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      creators.push(name);
    }
  }
  return creators;
}

/** creator filter 用 exact、case-insensitive 比對；來源與角色都必須一致 */
export function matchesMangaCreator(
  item: MangaSearchItem,
  filter: MangaCreatorFilter
): boolean {
  if (item.sourceId !== filter.sourceId) return false;
  const wanted = filter.name.trim().toLowerCase();
  const creators = filter.role
    ? getCreatorsFromField(item[filter.role])
    : getMangaCreators(item);
  return creators.some((creator) => creator.toLowerCase() === wanted);
}

/**
 * 每個有結果的來源與其筆數，供篩選 chip 與分組區塊使用。
 *
 * `streaming` 為 true 時**刻意不排序**。Map 的迭代是插入順序，也就是各來源
 * 首次回應的順序，在串流中是穩定的（新來源只加在尾端）。依筆數排的話 chip
 * 會在一次搜尋中重排三十幾次（單一來源一次進 100 筆就從隊尾跳到隊首），而
 * 使用者若在 mousedown 與 mouseup 之間遇上重排，button 節點被移走、兩個
 * 事件的 target 不同，瀏覽器會把 click 派送到最近共同祖先（沒有 handler）
 * —— 點擊被靜默吞掉，篩選沒套上。
 *
 * 串流結束後才切筆數降序：單源最多回 100 筆、一顆就佔全部結果的四到五成，
 * 把量多的排前面比首次回應順序有用，而這時只重排一次。
 */
export function buildSourceBuckets(
  results: MangaSearchItem[],
  options: { streaming: boolean }
): MangaSourceBucket[] {
  const counts = new Map<string, MangaSourceBucket>();
  for (const item of results) {
    const existing = counts.get(item.sourceId);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(item.sourceId, {
        sourceId: item.sourceId,
        sourceName: item.sourceName || item.sourceId,
        count: 1,
      });
    }
  }
  const buckets = Array.from(counts.values());
  if (options.streaming) return buckets;
  return buckets.sort((a, b) => b.count - a.count);
}

/**
 * 套用來源／作者篩選與排序後、真正要畫出來的結果。
 *
 * `sourceFilter` 為空陣列代表不篩選（顯示全部）。
 * creator filter 會同時比對來源與 exact creator 名稱：點作者後我們先限定
 * 同一來源重新搜尋，再用這層收斂，避免來源的模糊搜尋混入標題剛好含作者名、
 * 但 author 欄不是該作者的作品。
 */
export function selectVisibleResults(
  results: MangaSearchItem[],
  options: {
    sourceFilter: string[];
    sortMode: MangaResultSort;
    creatorFilter?: MangaCreatorFilter | null;
  }
): MangaSearchItem[] {
  const { sourceFilter, sortMode, creatorFilter } = options;
  const allowed = sourceFilter.length > 0 ? new Set(sourceFilter) : null;
  const sourceFiltered = allowed
    ? results.filter((item) => allowed.has(item.sourceId))
    : results;
  const filtered = creatorFilter
    ? sourceFiltered.filter((item) => matchesMangaCreator(item, creatorFilter))
    : sourceFiltered;
  if (sortMode === 'arrival') return filtered;
  /*
   * 一定要複製再排。無篩選時 `filtered` 就是傳入的 `results` 本身，而那是
   * React state —— 就地 sort 會改到 state 物件，React 比對不到變化，
   * 而下一次 append 又是基於被改過的陣列。
   */
  const sorted = [...filtered];
  if (sortMode === 'title') {
    sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
  } else {
    // source：來源名排序，同來源內維持到達順序（Array#sort 自 ES2019 起穩定）
    sorted.sort((a, b) =>
      (a.sourceName || a.sourceId).localeCompare(
        b.sourceName || b.sourceId,
        'zh-Hant'
      )
    );
  }
  return sorted;
}

/**
 * 分組模式下的區塊。
 *
 * 區塊順序要跟著 `sortMode` 走：分組後每一組內部的來源都相同，所以
 * 「來源名稱」排序若只作用在組內就完全看不出效果。選了它就改排區塊，
 * 其餘模式沿用 `buckets` 的順序（串流中是首次回應順序、結束後是筆數降序）。
 * 組內順序一律沿用傳入的 `visibleResults`（已套好篩選與排序）。
 */
export function groupResultsBySource(
  visibleResults: MangaSearchItem[],
  buckets: MangaSourceBucket[],
  options: { sortMode: MangaResultSort }
): MangaSourceGroup[] {
  const bySource = new Map<string, MangaSearchItem[]>();
  for (const item of visibleResults) {
    const list = bySource.get(item.sourceId);
    if (list) list.push(item);
    else bySource.set(item.sourceId, [item]);
  }
  /*
   * `filter` 已經產生新陣列，所以下面就地 sort 不會動到呼叫端的 `buckets`
   * （chip 也在用同一個陣列）。這一點由「不就地改動傳入的 buckets」那個
   * 測試守著 —— 若日後有人把這行改成直接用 `buckets`，測試會失敗。
   */
  const blocks = buckets.filter((bucket) => bySource.has(bucket.sourceId));
  if (options.sortMode === 'source') {
    blocks.sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'zh-Hant'));
  }
  return blocks.map((bucket) => ({
    ...bucket,
    items: bySource.get(bucket.sourceId) as MangaSearchItem[],
  }));
}

/**
 * 一批同時查詢的來源數。
 *
 * 使用者勾的來源實測可到 51 顆；一次全部 fan-out 時，停止搜尋也無法略過
 * 尚未開始的來源，而且數十顆同時完成會把結果 append 擠在同一小段時間。
 *
 * 5 是「一次能看到結果、又不會讓上游同時扛數十條連線」的折衷；序列批次還
 * 讓「停止」有意義 —— 未開始的批次直接不發，而不是只能等伺服器自己收尾。
 */
export const MANGA_SEARCH_BATCH_SIZE = 5;

/**
 * 一次 render 的結果卡片上限。
 *
 * 放寬來源上限後單次搜尋 300～400 筆是常態，而每張卡片都帶封面圖與數個
 * creator 按鈕。一次 render 全部會讓主執行緒在串流期間持續掉幀，
 * 所以資料 state 保留全部、畫面分段展開。
 */
export const MANGA_RESULT_RENDER_PAGE_SIZE = 96;

/**
 * 來源的速度／可用性線索。
 *
 * 刻意用真正的 probe／health 型別而不是就地寫結構型別：這兩份資料的欄位
 * （searchOk／failed／timedOut）任一邊改名，這裡才會編不過。
 */
export interface MangaSearchSourceHints {
  /** 管理員最近一次探測的快取（跨使用者共用） */
  probe?: Record<string, MangaSourceProbeSummary>;
  /** 本機被動量測（只有這台瀏覽器搜過的來源才有） */
  health?: Record<string, MangaSourceHealth>;
}

/**
 * 分級：數字越小越先查。
 * 0 = probe 成功、1 = 本機量測成功、2 = 沒有資料、
 * 3 = 本機量測逾時、4 = probe 或本機量測明確失敗。
 */
type MangaSearchSourceTier = 0 | 1 | 2 | 3 | 4;

function rankSearchSource(
  probe: MangaSourceProbeSummary | undefined,
  health: MangaSourceHealth | undefined
): { tier: MangaSearchSourceTier; cost: number } {
  // probe 是管理員實際測過的搜尋能力，存在時必須優先於本機舊量測。
  if (probe) {
    return probe.searchOk
      ? { tier: 0, cost: probe.searchMs }
      : { tier: 4, cost: 0 };
  }
  if (health && !health.failed) {
    // failed=false 但沒有 elapsedMs：仍算成功，只是排在有數字的後面
    return {
      tier: 1,
      cost:
        typeof health.elapsedMs === 'number'
          ? health.elapsedMs
          : Number.MAX_SAFE_INTEGER,
    };
  }
  // 逾時不等於失效（見 MangaSourceHealth.timedOut），所以排在明確失敗之前
  if (health?.failed) return { tier: health.timedOut ? 3 : 4, cost: 0 };
  return { tier: 2, cost: 0 };
}

/**
 * 先依 probe／本機量測／未知／失敗分級，同級再依已知耗時排序。
 *
 * 序列批次讓順序變得有意義：第一批決定使用者等多久才看到第一張卡片。
 * 已知失敗／逾時排在最後，因此 maxSources 截斷時會優先犧牲這些來源；
 * 被截斷的來源仍可能有結果。
 *
 * 同級同耗時維持傳入順序（Array#sort 自 ES2019 起穩定），所以不會因為
 * 兩顆來源速度相同就在每次搜尋間跳動。
 */
export function orderMangaSearchSources(
  sourceIds: string[],
  hints: MangaSearchSourceHints = {}
): string[] {
  // Set 保留首次出現順序，等同「去重後維持傳入順序」
  const unique = Array.from(new Set(sourceIds.map((id) => id.trim()))).filter(
    Boolean
  );

  return unique
    .map((id, index) => ({
      id,
      index,
      ...rankSearchSource(hints.probe?.[id], hints.health?.[id]),
    }))
    .sort((a, b) => a.tier - b.tier || a.cost - b.cost || a.index - b.index)
    .map((entry) => entry.id);
}

/** 切成固定大小的批次；無效 size 用預設值，size < 1 時每批一顆 */
export function chunkMangaSearchSources(
  sourceIds: string[],
  size: number = MANGA_SEARCH_BATCH_SIZE
): string[][] {
  if (sourceIds.length === 0) return [];
  const step = Number.isFinite(size)
    ? Math.max(1, Math.floor(size))
    : MANGA_SEARCH_BATCH_SIZE;
  const chunks: string[][] = [];
  for (let i = 0; i < sourceIds.length; i += step) {
    chunks.push(sourceIds.slice(i, i + step));
  }
  return chunks;
}

export type MangaSearchBatch =
  | { sourceIds: string[]; total: 'planned' }
  | { sourceIds: string[] | null; total: 'server' };

interface MangaSearchBatchPlanOptions {
  requestedSourceIds: string[];
  defaultSourceIds: string[];
  maxSources?: number;
  hints?: MangaSearchSourceHints;
}

/**
 * 規劃整輪搜尋。`defaultSourceIds` 只是目前預設語言的清單，不能拿來刪除
 * 明確指定、但屬於其他語言的來源；每批仍由伺服器做最終授權。
 *
 * 來源清單 API 失敗時拿不到 maxSources。明確選源改成單一 server-counted
 * request，讓伺服器維持全域上限；不可自行拆成多批後讓每批各吃一次上限。
 */
export function planMangaSearchBatches({
  requestedSourceIds,
  defaultSourceIds,
  maxSources,
  hints,
}: MangaSearchBatchPlanOptions): MangaSearchBatch[] {
  const requested = orderMangaSearchSources(requestedSourceIds, hints);
  // null＝拿不到有效上限，這一輪不能自己拆批
  const limit =
    typeof maxSources === 'number' &&
    Number.isFinite(maxSources) &&
    maxSources > 0
      ? Math.floor(maxSources)
      : null;

  const explicit = requested.length > 0;
  const candidates = explicit
    ? requested
    : orderMangaSearchSources(defaultSourceIds, hints);

  if (limit === null || candidates.length === 0) {
    // 明確選源仍要送出，否則伺服器會退回預設語言清單
    return [{ sourceIds: explicit ? requested : null, total: 'server' }];
  }
  return chunkMangaSearchSources(candidates.slice(0, limit)).map(
    (sourceIds) => ({ sourceIds, total: 'planned' })
  );
}
