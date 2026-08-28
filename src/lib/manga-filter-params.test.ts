/**
 * 來源 filter 的兩個承重邏輯：
 *
 * 1. `buildFilterChangeInputs` —— 使用者的選擇轉成 Suwayomi 的
 *    FilterChangeInput。group 會展開成多筆（一筆 groupChange 只能改一個
 *    勾選框），轉換不再是 1:1，值得測試守著。
 * 2. `parseMangaFilterSelections` —— filters 是客戶端給的 JSON，會被原樣
 *    轉成 GraphQL 變數送給上游，每一筆的形狀都要驗過。
 */

import type {
  MangaFilterSelection,
  MangaSourceFilterOption,
} from '@/lib/manga.types';
import {
  buildFilterChangeInputs,
  isSameFilterControl,
  upsertFilterSelection,
} from '@/lib/manga.types';
import {
  MAX_FILTER_ENTRIES,
  MAX_FILTER_INDEX,
  MAX_GROUP_SELECTIONS,
  parseMangaFilterSelections,
} from '@/lib/manga-filter-params';

describe('buildFilterChangeInputs', () => {
  it('select 轉 selectState', () => {
    expect(
      buildFilterChangeInputs([{ position: 2, kind: 'select', index: 3 }])
    ).toEqual([{ position: 2, selectState: 3 }]);
  });

  it('sort 轉 sortState，預設降冪', () => {
    expect(
      buildFilterChangeInputs([{ position: 0, kind: 'sort', index: 1 }])
    ).toEqual([{ position: 0, sortState: { index: 1, ascending: false } }]);
  });

  it('sort 的 ascending: true 完整往返 —— 升冪不會靜默變降冪', () => {
    /*
     * 這是會靜默失敗的那一類：ascending 的存活靠 parse 端的條件展開
     * `...(typeof ascending === 'boolean' ? { ascending } : {})`，
     * build 端則是 `selection.ascending ?? false`。把 parse 端那段刪掉，
     * 升冪排序會變成降冪，而其他測試全數照過。
     */
    const parsed = parseMangaFilterSelections(
      JSON.stringify([{ position: 0, kind: 'sort', index: 2, ascending: true }])
    );
    expect(parsed).toEqual([
      { position: 0, kind: 'sort', index: 2, ascending: true },
    ]);
    if (!parsed) throw new Error('parse 應該成功');
    expect(buildFilterChangeInputs(parsed)).toEqual([
      { position: 0, sortState: { index: 2, ascending: true } },
    ]);
  });

  it('sort 的 ascending: false 明確給定時也要原樣往返', () => {
    const parsed = parseMangaFilterSelections(
      JSON.stringify([{ position: 3, kind: 'sort', index: 1, ascending: false }])
    );
    expect(parsed).toEqual([
      { position: 3, kind: 'sort', index: 1, ascending: false },
    ]);
    if (!parsed) throw new Error('parse 應該成功');
    expect(buildFilterChangeInputs(parsed)).toEqual([
      { position: 3, sortState: { index: 1, ascending: false } },
    ]);
  });

  it('checkbox 轉 checkBoxState', () => {
    expect(
      buildFilterChangeInputs([{ position: 5, kind: 'checkbox', checked: true }])
    ).toEqual([{ position: 5, checkBoxState: true }]);
  });

  it('group 展開成多筆 groupChange，一筆一個勾選框', () => {
    expect(
      buildFilterChangeInputs([
        { position: 1, kind: 'group', positions: [0, 4, 17] },
      ])
    ).toEqual([
      { position: 1, groupChange: { position: 0, checkBoxState: true } },
      { position: 1, groupChange: { position: 4, checkBoxState: true } },
      { position: 1, groupChange: { position: 17, checkBoxState: true } },
    ]);
  });

  it('group_select 轉巢狀 groupChange，用 selectState 而非 checkBoxState', () => {
    // 把 position 與 innerPosition 對調、或把 selectState 誤寫成 checkBoxState，
    // 兩者都能通過 tsc 且不影響其他測試 —— 這裡把它們同時釘住
    expect(
      buildFilterChangeInputs([
        { position: 7, kind: 'group_select', innerPosition: 2, index: 5 },
      ])
    ).toEqual([{ position: 7, groupChange: { position: 2, selectState: 5 } }]);
  });

  it('同一群組的多個下拉各自成一筆，不互相覆蓋', () => {
    // 喜漫的「分组标签」群組內是 4 個 SelectFilter，共用頂層 position。
    // 只用 position 當識別鍵會讓它們蓋掉彼此。
    expect(
      buildFilterChangeInputs([
        { position: 7, kind: 'group_select', innerPosition: 0, index: 1 },
        { position: 7, kind: 'group_select', innerPosition: 3, index: 2 },
      ])
    ).toEqual([
      { position: 7, groupChange: { position: 0, selectState: 1 } },
      { position: 7, groupChange: { position: 3, selectState: 2 } },
    ]);
  });

  it('同一 position 的 group 勾選與 group_select 下拉並存', () => {
    // GroupFilter 現在會在同一個頂層 position 吐出兩種 kind，
    // 兩者必須都送出去，不能互斥
    expect(
      buildFilterChangeInputs([
        { position: 1, kind: 'group', positions: [0] },
        { position: 1, kind: 'group_select', innerPosition: 2, index: 4 },
      ])
    ).toEqual([
      { position: 1, groupChange: { position: 0, checkBoxState: true } },
      { position: 1, groupChange: { position: 2, selectState: 4 } },
    ]);
  });

  it('混合多種 kind 保持順序', () => {
    const out = buildFilterChangeInputs([
      { position: 2, kind: 'select', index: 0 },
      { position: 1, kind: 'group', positions: [3, 7] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ position: 2, selectState: 0 });
    expect(out[1].groupChange?.position).toBe(3);
    expect(out[2].groupChange?.position).toBe(7);
  });
});

describe('parseMangaFilterSelections', () => {
  it('沒帶參數回空陣列（不是錯誤）', () => {
    expect(parseMangaFilterSelections(null)).toEqual([]);
    expect(parseMangaFilterSelections('')).toEqual([]);
  });

  it('接受合法的 group 選擇', () => {
    expect(
      parseMangaFilterSelections(
        JSON.stringify([{ position: 1, kind: 'group', positions: [0, 4] }])
      )
    ).toEqual([{ position: 1, kind: 'group', positions: [0, 4] }]);
  });

  it('接受合法的 checkbox 選擇', () => {
    expect(
      parseMangaFilterSelections(
        JSON.stringify([{ position: 3, kind: 'checkbox', checked: true }])
      )
    ).toEqual([{ position: 3, kind: 'checkbox', checked: true }]);
  });

  it('接受合法的 group_select 選擇', () => {
    expect(
      parseMangaFilterSelections(
        JSON.stringify([
          { position: 7, kind: 'group_select', innerPosition: 3, index: 2 },
        ])
      )
    ).toEqual([
      { position: 7, kind: 'group_select', innerPosition: 3, index: 2 },
    ]);
  });

  it.each([
    ['group 空 positions', [{ position: 1, kind: 'group', positions: [] }]],
    ['group positions 含負數', [{ position: 1, kind: 'group', positions: [-1] }]],
    ['group positions 含小數', [{ position: 1, kind: 'group', positions: [1.5] }]],
    ['group positions 含字串', [{ position: 1, kind: 'group', positions: ['0'] }]],
    ['group 缺 positions', [{ position: 1, kind: 'group' }]],
    ['checkbox 缺 checked', [{ position: 1, kind: 'checkbox' }]],
    ['checkbox checked 非布林', [{ position: 1, kind: 'checkbox', checked: 'yes' }]],
    ['未知 kind', [{ position: 1, kind: 'text', value: 'x' }]],
    ['select 缺 index', [{ position: 1, kind: 'select' }]],
    [
      'group_select 缺 innerPosition',
      [{ position: 1, kind: 'group_select', index: 2 }],
    ],
    [
      'group_select innerPosition 為負',
      [{ position: 1, kind: 'group_select', innerPosition: -1, index: 2 }],
    ],
    [
      'group_select innerPosition 為小數',
      [{ position: 1, kind: 'group_select', innerPosition: 1.5, index: 2 }],
    ],
    [
      'group_select 缺 index',
      [{ position: 1, kind: 'group_select', innerPosition: 0 }],
    ],
    [
      'position 超過索引上限',
      [{ position: MAX_FILTER_INDEX + 1, kind: 'select', index: 0 }],
    ],
    [
      'index 超過索引上限',
      [{ position: 1, kind: 'select', index: MAX_FILTER_INDEX + 1 }],
    ],
    [
      'group_select innerPosition 超過索引上限',
      [
        {
          position: 1,
          kind: 'group_select',
          innerPosition: MAX_FILTER_INDEX + 1,
          index: 0,
        },
      ],
    ],
    [
      'group positions 含超過索引上限的值',
      [{ position: 1, kind: 'group', positions: [MAX_FILTER_INDEX + 1] }],
    ],
    [
      'index 為 MAX_SAFE_INTEGER',
      [{ position: 1, kind: 'select', index: Number.MAX_SAFE_INTEGER }],
    ],
  ])('%s → 整包拒絕', (_label, payload) => {
    expect(parseMangaFilterSelections(JSON.stringify(payload))).toBeNull();
  });

  it('group positions 超過上限整包拒絕', () => {
    const positions = Array.from({ length: MAX_GROUP_SELECTIONS + 1 }, (_, i) => i);
    expect(
      parseMangaFilterSelections(
        JSON.stringify([{ position: 1, kind: 'group', positions }])
      )
    ).toBeNull();
  });


  it('頂層條目超過上限整包拒絕', () => {
    const entries = Array.from({ length: MAX_FILTER_ENTRIES + 1 }, (_, i) => ({
      position: i % (MAX_FILTER_INDEX + 1),
      kind: 'select',
      index: 0,
    }));
    expect(parseMangaFilterSelections(JSON.stringify(entries))).toBeNull();
  });

  it('數量恰好等於上限必須被接受（釘住兩個數量上限的邊界方向）', () => {
    /*
     * 與索引上限同一個理由：只斷言 +1 被拒的話，把
     * `parsed.length > MAX_FILTER_ENTRIES` 改成 `>=`、
     * `rawPositions.length > MAX_GROUP_SELECTIONS` 改成 `>=`，
     * 51／201 仍被拒、所有測試仍全綠，實際上限卻靜默變成 49／199。
     */
    const positions = Array.from({ length: MAX_GROUP_SELECTIONS }, (_, i) => i);
    expect(
      parseMangaFilterSelections(
        JSON.stringify([{ position: 1, kind: 'group', positions }])
      )
    ).toEqual([{ position: 1, kind: 'group', positions }]);

    const entries = Array.from({ length: MAX_FILTER_ENTRIES }, (_, i) => ({
      position: i,
      kind: 'select' as const,
      index: 0,
    }));
    expect(parseMangaFilterSelections(JSON.stringify(entries))).toEqual(entries);
  });

  it('索引恰好等於上限必須被接受（釘住邊界方向）', () => {
    /*
     * 只斷言 MAX_FILTER_INDEX + 1 被拒是不夠的：把 readNumber 的
     * `value <= MAX_FILTER_INDEX` 改成 `<`、group positions 的
     * `value > MAX_FILTER_INDEX` 改成 `>=`，1001 仍會被拒、
     * 所有拒絕測試仍全綠，差一格的變異完整存活。
     */
    const atLimit = { position: MAX_FILTER_INDEX, kind: 'select', index: MAX_FILTER_INDEX };
    expect(parseMangaFilterSelections(JSON.stringify([atLimit]))).toEqual([atLimit]);

    const innerAtLimit = {
      position: MAX_FILTER_INDEX,
      kind: 'group_select',
      innerPosition: MAX_FILTER_INDEX,
      index: MAX_FILTER_INDEX,
    };
    expect(parseMangaFilterSelections(JSON.stringify([innerAtLimit]))).toEqual([
      innerAtLimit,
    ]);

    const groupAtLimit = { position: 1, kind: 'group', positions: [MAX_FILTER_INDEX] };
    expect(parseMangaFilterSelections(JSON.stringify([groupAtLimit]))).toEqual([
      groupAtLimit,
    ]);
  });
  it('一筆壞掉時整包拒絕，不做部分接受', () => {
    // 部分接受會讓「送了 3 個條件、實際只套 2 個」靜默發生，
    // 使用者看到的結果與選擇不符卻沒有任何錯誤
    expect(
      parseMangaFilterSelections(
        JSON.stringify([
          { position: 1, kind: 'select', index: 0 },
          { position: 2, kind: 'group', positions: [-1] },
        ])
      )
    ).toBeNull();
  });
});

/*
 * isSameFilterControl —— 決定「改一個 filter 控制項時，哪些既有選擇要被取代」。
 *
 * 這是 page.tsx 五處 setFilterSelections 共用的判斷。它會靜默失敗：
 * 判斷寫得太寬就吃掉兄弟控制項已選的值，寫得太窄就留下重複選擇，
 * 兩種都不會報錯，只是送給上游的條件與畫面不符。
 */
describe('isSameFilterControl', () => {
  const selectControl: MangaSourceFilterOption = {
    position: 1,
    kind: 'select',
    name: '类型',
    values: ['全部', '少男漫画'],
  };
  const groupControl: MangaSourceFilterOption = {
    position: 7,
    kind: 'group',
    name: '分组标签',
    options: [{ position: 0, name: '热血' }],
  };
  const innerSelect0: MangaSourceFilterOption = {
    position: 7,
    kind: 'group_select',
    innerPosition: 0,
    name: '少男漫画',
    values: ['全部', '热血'],
  };
  const innerSelect3: MangaSourceFilterOption = {
    position: 7,
    kind: 'group_select',
    innerPosition: 3,
    name: '成人漫画',
    values: ['全部', '巨乳'],
  };

  it('同一個頂層下拉：select 與 sort 雙向都視為同一個控制項', () => {
    /*
     * 一個頂層 filter 只會是 select 或 sort 之一，使用者看到的是同一個下拉。
     * 兩個 case 都要測：只用 selectControl 當第二參數的話，
     * `case 'sort'` 分支零覆蓋 —— 把它改成只匹配 item.kind === 'sort'
     * 也不會有測試失敗，同 position 的 select 選擇就會累積成重複。
     */
    const sortControl: MangaSourceFilterOption = {
      position: 1,
      kind: 'sort',
      name: '排序',
      values: ['人气推荐', '更新时间'],
    };
    // control 是 select
    expect(
      isSameFilterControl({ position: 1, kind: 'select', index: 0 }, selectControl)
    ).toBe(true);
    expect(
      isSameFilterControl({ position: 1, kind: 'sort', index: 0 }, selectControl)
    ).toBe(true);
    // control 是 sort —— 反方向，先前沒被覆蓋
    expect(
      isSameFilterControl({ position: 1, kind: 'sort', index: 0 }, sortControl)
    ).toBe(true);
    expect(
      isSameFilterControl({ position: 1, kind: 'select', index: 0 }, sortControl)
    ).toBe(true);
    // 其他 kind 不受這個等價影響
    expect(
      isSameFilterControl({ position: 1, kind: 'checkbox', checked: true }, sortControl)
    ).toBe(false);
  });

  it('不同 position 的頂層下拉互不相干', () => {
    expect(
      isSameFilterControl({ position: 2, kind: 'select', index: 0 }, selectControl)
    ).toBe(false);
  });

  it('同一群組內的不同下拉互不相干（共用頂層 position）', () => {
    // 喜漫「分组标签」的 4 個下拉全部是 position 7，只比 position 會互相清掉
    const chosen: MangaFilterSelection = {
      position: 7,
      kind: 'group_select',
      innerPosition: 0,
      index: 7,
    };
    expect(isSameFilterControl(chosen, innerSelect0)).toBe(true);
    expect(isSameFilterControl(chosen, innerSelect3)).toBe(false);
  });

  it('同一 position 的 group chip 與 group_select 互不相干', () => {
    const chipChoice: MangaFilterSelection = {
      position: 7,
      kind: 'group',
      positions: [0],
    };
    const dropdownChoice: MangaFilterSelection = {
      position: 7,
      kind: 'group_select',
      innerPosition: 0,
      index: 1,
    };
    // 改下拉不能清掉 chip 的勾選，改 chip 也不能清掉下拉
    expect(isSameFilterControl(chipChoice, innerSelect0)).toBe(false);
    expect(isSameFilterControl(dropdownChoice, groupControl)).toBe(false);
    expect(isSameFilterControl(chipChoice, groupControl)).toBe(true);
    expect(isSameFilterControl(dropdownChoice, innerSelect0)).toBe(true);
  });

  it('頂層 checkbox 不會被同 position 的其他 kind 取代', () => {
    const checkboxControl: MangaSourceFilterOption = {
      position: 7,
      kind: 'checkbox',
      name: '只看完结',
    };
    expect(
      isSameFilterControl({ position: 7, kind: 'checkbox', checked: true }, checkboxControl)
    ).toBe(true);
    expect(
      isSameFilterControl({ position: 7, kind: 'group', positions: [0] }, checkboxControl)
    ).toBe(false);
    expect(
      isSameFilterControl({ position: 7, kind: 'checkbox', checked: true }, groupControl)
    ).toBe(false);
  });

  it('upsertFilterSelection：改群組內一個下拉，兄弟選擇全部留存', () => {
    /*
     * 這個測試呼叫的是 page.tsx 五處 updater 實際使用的那個函式。
     * 先前的版本在測試檔內自行重寫 filter + concat，所以把 page.tsx 的
     * rest 過濾退回「只比 position」時測試照樣全綠 —— 假保證。
     */
    const prev: MangaFilterSelection[] = [
      { position: 1, kind: 'select', index: 1 },
      { position: 7, kind: 'group', positions: [0, 4] },
      { position: 7, kind: 'group_select', innerPosition: 0, index: 7 },
      { position: 7, kind: 'group_select', innerPosition: 3, index: 2 },
    ];
    const next = upsertFilterSelection(prev, innerSelect0, {
      position: 7,
      kind: 'group_select',
      innerPosition: 0,
      index: 12,
    });
    expect(next).toEqual([
      { position: 1, kind: 'select', index: 1 },
      { position: 7, kind: 'group', positions: [0, 4] },
      { position: 7, kind: 'group_select', innerPosition: 3, index: 2 },
      { position: 7, kind: 'group_select', innerPosition: 0, index: 12 },
    ]);
    // 而且轉成上游請求後，四個條件一個都不能少
    expect(buildFilterChangeInputs(next)).toHaveLength(5);
  });

  it('upsertFilterSelection：改頂層下拉不會動到同 position 的群組選擇', () => {
    // 這是抽出這個函式的理由：退回「只比 position」時，
    // 下面 position 7 的三筆會被一起清掉
    const prev: MangaFilterSelection[] = [
      { position: 7, kind: 'group', positions: [0] },
      { position: 7, kind: 'group_select', innerPosition: 0, index: 7 },
      { position: 7, kind: 'checkbox', checked: true },
    ];
    const topLevelSelectAt7: MangaSourceFilterOption = {
      position: 7,
      kind: 'select',
      name: '类型',
      values: ['全部', '少男漫画'],
    };
    const next = upsertFilterSelection(prev, topLevelSelectAt7, {
      position: 7,
      kind: 'select',
      index: 1,
    });
    expect(next).toEqual([
      { position: 7, kind: 'group', positions: [0] },
      { position: 7, kind: 'group_select', innerPosition: 0, index: 7 },
      { position: 7, kind: 'checkbox', checked: true },
      { position: 7, kind: 'select', index: 1 },
    ]);
  });

  it('upsertFilterSelection：next 為 null 只移除、不新增', () => {
    // 下拉選空白、checkbox 取消勾選、群組 chip 全部取消都走這條路
    const prev: MangaFilterSelection[] = [
      { position: 1, kind: 'select', index: 1 },
      { position: 7, kind: 'group_select', innerPosition: 0, index: 7 },
    ];
    expect(upsertFilterSelection(prev, innerSelect0, null)).toEqual([
      { position: 1, kind: 'select', index: 1 },
    ]);
    expect(upsertFilterSelection(prev, selectControl, null)).toEqual([
      { position: 7, kind: 'group_select', innerPosition: 0, index: 7 },
    ]);
  });

  it('upsertFilterSelection：同一控制項重複選取不會累積', () => {
    const prev: MangaFilterSelection[] = [
      { position: 1, kind: 'select', index: 1 },
    ];
    const once = upsertFilterSelection(prev, selectControl, {
      position: 1,
      kind: 'select',
      index: 2,
    });
    const twice = upsertFilterSelection(once, selectControl, {
      position: 1,
      kind: 'select',
      index: 3,
    });
    expect(twice).toEqual([{ position: 1, kind: 'select', index: 3 }]);
  });

  it('upsertFilterSelection：next 與 control 不一致時直接丟錯', () => {
    /*
     * 識別鍵（position / kind / innerPosition）都只是 number 或字面量，
     * 型別擋不住呼叫端組錯。不擋的話：舊值被移除、新值掛到另一個識別鍵上，
     * 畫面顯示該控制項未選、上游卻收到一筆多餘條件，而且完全不報錯。
     * 兩條 review lane 各自指出這是這個 export 最關鍵的跨參數 invariant。
     */
    const prev: MangaFilterSelection[] = [
      { position: 7, kind: 'group_select', innerPosition: 0, index: 7 },
    ];
    // innerPosition 抄錯：control 是 inner 0，next 卻指向 inner 3
    expect(() =>
      upsertFilterSelection(prev, innerSelect0, {
        position: 7,
        kind: 'group_select',
        innerPosition: 3,
        index: 5,
      })
    ).toThrow(/不屬於 control/);
    // position 抄錯
    expect(() =>
      upsertFilterSelection(prev, selectControl, {
        position: 2,
        kind: 'select',
        index: 0,
      })
    ).toThrow(/不屬於 control/);
    // kind 抄錯：control 是頂層 select，next 卻是 checkbox
    expect(() =>
      upsertFilterSelection(prev, selectControl, {
        position: 1,
        kind: 'checkbox',
        checked: true,
      })
    ).toThrow(/不屬於 control/);
    // 一致的 pair 不受影響
    expect(() =>
      upsertFilterSelection(prev, innerSelect0, {
        position: 7,
        kind: 'group_select',
        innerPosition: 0,
        index: 5,
      })
    ).not.toThrow();
    // select 與 sort 互為同一控制項，不算不一致
    expect(() =>
      upsertFilterSelection(prev, selectControl, {
        position: 1,
        kind: 'sort',
        index: 0,
      })
    ).not.toThrow();
  });
});
