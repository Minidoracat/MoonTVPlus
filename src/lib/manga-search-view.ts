import type { MangaSearchItem } from '@/lib/manga.types';
import { MAX_KEYWORD_LENGTH } from '@/lib/manga-search-params';

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
  items: MangaSearchItem[];
}

export interface MangaCreatorFilter {
  sourceId: string;
  name: string;
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

/**
 * 從 Suwayomi 的 author / artist 欄位取出可點擊的作者／上傳者。
 *
 * 上游沒有獨立的 uploader 欄位；不同 extension 會把作者、繪師、社團或
 * 上傳者塞進 author／artist。UI 統一叫「作者／上傳者」，不假裝能分辨角色。
 * 超過搜尋 API q 上限的單一名字不做按鈕，避免顯示一顆點了必定 400 的操作。
 */
export function getMangaCreators(item: MangaSearchItem): string[] {
  const seen = new Set<string>();
  const creators: string[] = [];
  for (const raw of [item.author, item.artist]) {
    if (!raw) continue;
    const rawName = raw.trim();
    /*
     * 整欄 N/A（也接受 `N / A` 的空白變體）先忽略；多人欄位交給
     * splitCreatorField，在保留獨立 N/A token 的同時拆其他分隔符。
     * 不用字串 sentinel：上游 JSON 可合法帶任意 control/private-use 字元，
     * sentinel 無論固定或動態都要處理碰撞與上限，scanner 反而更短且線性。
     */
    if (IGNORED_CREATORS.has(rawName.replace(/\s+/g, '').toLowerCase())) {
      continue;
    }
    for (const part of splitCreatorField(rawName)) {
      const name = part.trim();
      const normalized = name.toLowerCase();
      // ignore 查表要與整欄 guard 一樣移除空白，否則 scanner 保護下來的
      // `N / A`／`N /A`／`N/ A` 會變成假作者按鈕。dedupe key 仍保留空白：
      // 合法名稱 `A B` 與 `AB` 不該被合併。
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
  }
  return creators;
}

/** creator filter 用 exact、case-insensitive 比對；來源也必須一致 */
export function matchesMangaCreator(
  item: MangaSearchItem,
  filter: MangaCreatorFilter
): boolean {
  if (item.sourceId !== filter.sourceId) return false;
  const wanted = filter.name.trim().toLowerCase();
  return getMangaCreators(item).some(
    (creator) => creator.toLowerCase() === wanted
  );
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
