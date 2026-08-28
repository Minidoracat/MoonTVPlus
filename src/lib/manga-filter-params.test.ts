/**
 * 來源 filter 的兩個承重邏輯：
 *
 * 1. `buildFilterChangeInputs` —— 使用者的選擇轉成 Suwayomi 的
 *    FilterChangeInput。group 會展開成多筆（一筆 groupChange 只能改一個
 *    勾選框），轉換不再是 1:1，值得測試守著。
 * 2. `parseMangaFilterSelections` —— filters 是客戶端給的 JSON，會被原樣
 *    轉成 GraphQL 變數送給上游，每一筆的形狀都要驗過。
 */

import {
  MAX_GROUP_SELECTIONS,
  parseMangaFilterSelections,
} from '@/lib/manga-filter-params';
import { buildFilterChangeInputs } from '@/lib/manga.types';

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
    const entries = Array.from({ length: 51 }, (_, i) => ({
      position: i,
      kind: 'select',
      index: 0,
    }));
    expect(parseMangaFilterSelections(JSON.stringify(entries))).toBeNull();
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
