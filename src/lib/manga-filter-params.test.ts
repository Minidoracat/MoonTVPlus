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
