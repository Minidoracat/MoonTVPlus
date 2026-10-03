import {
  type MangaFilterSelection,
  type MangaSourceFilterOption,
  buildFilterChangeInputs,
} from './manga.types';

/**
 * 推薦頁的「本日／本周／本月」近期熱門。
 *
 * Suwayomi 沒有「近期熱門」這個概念，只有各來源自帶的 filter：有的把它放進
 * 排序（漫画柜「日排行」、Hanime1.me「熱門：本日」），有的拆成「時間 + 排序」
 * 兩個下拉（禁漫天堂「今天」＋「最多浏览」）。這裡從 filter 名稱推出對應的
 * selection，切換時就是套一組 filter，走既有的 SEARCH 路徑。
 */
export type MangaHotWindow = 'day' | 'week' | 'month';

/** key 的順序就是 UI 顯示順序 */
export const MANGA_HOT_WINDOW_LABELS: Record<MangaHotWindow, string> = {
  day: '本日',
  week: '本周',
  month: '本月',
};

/*
 * 刻意不認「三日內／七日內／一月內」：那是「更新時間」篩選（嗶哩漫畫），
 * 不是熱門榜，套上去只會得到最近更新的作品。
 */
const WINDOW_PATTERNS: Record<MangaHotWindow, RegExp> = {
  day: /日排行|日榜|本日|今日|今天|24\s*小[时時]/,
  week: /[周週]排行|[周週]榜|本[周週]|[这這][周週]|7\s*天|[周週][点點][击擊]/,
  month: /月排行|月榜|本月|30\s*天|月[点點][击擊]/,
};

const POPULARITY =
  /排行|榜|热门|熱門|人气|人氣|[点點][击擊]|[观觀]看|[浏瀏][览覽]|views?|popular|hot|trending/i;
const NEUTRAL = /^(全部|不限|所有|无|無|all|none|不查看.*)$/i;

type ChoiceControl = Extract<
  MangaSourceFilterOption,
  { kind: 'select' | 'sort' | 'group_select' }
>;

/** 形狀與推薦頁下拉建立的 selection 一致，matchMangaHotWindow 才比得起來 */
function toSelection(control: ChoiceControl, index: number): MangaFilterSelection {
  switch (control.kind) {
    case 'sort':
      return { position: control.position, kind: 'sort', index, ascending: false };
    case 'select':
      return { position: control.position, kind: 'select', index };
    case 'group_select':
      return {
        position: control.position,
        kind: 'group_select',
        innerPosition: control.innerPosition,
        index,
      };
  }
}

/**
 * 只有時間的下拉要配一個「熱門」排序，否則禁漫天堂「今天」配上預設的
 * 「最新」就只是今天更新的作品。群組內的下拉先找同一群組的兄弟。
 */
function findPopularityPartner(
  controls: ChoiceControl[],
  control: ChoiceControl
): MangaFilterSelection | null {
  const others = controls.filter((other) => other !== control);
  const ordered =
    control.kind === 'group_select'
      ? [
          ...others.filter((other) => other.position === control.position),
          ...others.filter((other) => other.position !== control.position),
        ]
      : others;
  for (const other of ordered) {
    const index = other.values.findIndex(
      (label) => !NEUTRAL.test(label.trim()) && POPULARITY.test(label)
    );
    if (index >= 0) return toSelection(other, index);
  }
  return null;
}

export function findMangaHotWindows(
  filters: MangaSourceFilterOption[]
): Partial<Record<MangaHotWindow, MangaFilterSelection[]>> {
  const controls = filters.filter(
    (filter): filter is ChoiceControl =>
      filter.kind === 'select' ||
      filter.kind === 'sort' ||
      filter.kind === 'group_select'
  );
  const windows: Partial<Record<MangaHotWindow, MangaFilterSelection[]>> = {};
  for (const window of Object.keys(WINDOW_PATTERNS) as MangaHotWindow[]) {
    for (const control of controls) {
      const index = control.values.findIndex((label) =>
        WINDOW_PATTERNS[window].test(label)
      );
      if (index < 0) continue;
      const selections = [toSelection(control, index)];
      /*
       * 標籤本身沒有熱門字眼、且這個下拉除了「全部／不限」之外全是時間窗
       * （只決定時間、不決定排序）時，才需要配一個熱門排序。
       */
      const timeOnly = control.values
        .filter((label) => !NEUTRAL.test(label.trim()))
        .every((label) =>
          Object.values(WINDOW_PATTERNS).some((pattern) => pattern.test(label))
        );
      if (!POPULARITY.test(control.values[index]) && timeOnly) {
        const partner = findPopularityPartner(controls, control);
        if (partner) selections.push(partner);
      }
      windows[window] = selections;
      break;
    }
  }
  return windows;
}

/** 目前的 filter 恰好是某個時間窗（順序不拘、不多不少）就回傳它 */
export function matchMangaHotWindow(
  windows: Partial<Record<MangaHotWindow, MangaFilterSelection[]>>,
  selections: MangaFilterSelection[]
): MangaHotWindow | null {
  const signature = (list: MangaFilterSelection[]) =>
    JSON.stringify(
      list.map((item) => JSON.stringify(buildFilterChangeInputs([item]))).sort()
    );
  const current = signature(selections);
  for (const window of Object.keys(MANGA_HOT_WINDOW_LABELS) as MangaHotWindow[]) {
    const candidate = windows[window];
    if (
      candidate &&
      candidate.length === selections.length &&
      signature(candidate) === current
    ) {
      return window;
    }
  }
  return null;
}
