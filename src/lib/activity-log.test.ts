/**
 * 操作紀錄的 API 邊界正規化。
 *
 * 這裡是信任邊界：客戶端送什麼都可能，寫進 kvrocks 前必須收斂成固定形狀。
 */

import { normalizeActivityEvents } from '@/lib/activity-log';

const now = Date.now();
const base = { t: now, sid: 's1', path: '/manga' };
const tap = {
  ...base,
  type: 'tap',
  x: 10,
  y: 20,
  sy: 300,
  wy: 0,
  tag: 'a',
  name: '漫畫',
  href: '/manga/detail?id=1',
  interactive: true,
  clicked: false,
};

describe('normalizeActivityEvents', () => {
  it('非陣列輸入回傳空陣列', () => {
    expect(normalizeActivityEvents(undefined)).toEqual([]);
    expect(normalizeActivityEvents({ events: [] })).toEqual([]);
  });

  it('丟棄未知型別與非物件，保留合法事件', () => {
    const out = normalizeActivityEvents([{ ...base, type: 'hack' }, null, 'x', { ...base, type: 'vis', state: 'hidden' }]);
    expect(out).toEqual([{ ...base, type: 'vis', state: 'hidden' }]);
  });

  it('丟棄未知欄位', () => {
    const [out] = normalizeActivityEvents([{ ...base, type: 'nav', from: '/', password: 'secret' }]);
    expect(out).toEqual({ ...base, type: 'nav', from: '/' });
  });

  it('截斷過長字串', () => {
    const [out] = normalizeActivityEvents([
      { ...tap, sid: 'x'.repeat(50), path: 'p'.repeat(500), tag: 't'.repeat(30), name: 'n'.repeat(100), href: 'h'.repeat(300) },
    ]);
    expect(out).toMatchObject({ sid: 'x'.repeat(32), path: 'p'.repeat(300), tag: 't'.repeat(16), name: 'n'.repeat(40), href: 'h'.repeat(200) });
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['字串數字', '10'],
  ])('數值欄位為 %s 時整筆丟棄', (_label, x) => {
    expect(normalizeActivityEvents([{ ...tap, x }])).toEqual([]);
  });

  it('缺少必填欄位整筆丟棄；href 選填，不合法時只略過該欄', () => {
    const { clicked: _c, ...noClicked } = tap;
    expect(normalizeActivityEvents([noClicked])).toEqual([]);
    const { href: _h, ...noHref } = tap;
    expect(normalizeActivityEvents([noHref])).toEqual([noHref]);
    expect(normalizeActivityEvents([{ ...tap, href: 42 }])).toEqual([noHref]);
  });

  it('vis.state 只接受 hidden / visible', () => {
    expect(normalizeActivityEvents([{ ...base, type: 'vis', state: 'prerender' }])).toEqual([]);
  });

  it('每次最多 100 筆', () => {
    const events = Array.from({ length: 150 }, () => ({ ...base, type: 'vis', state: 'visible' }));
    expect(normalizeActivityEvents(events)).toHaveLength(100);
  });

  it.each([
    ['超過 1 天後的未來', now + 25 * 60 * 60 * 1000],
    ['超過 7 天前', now - 8 * 24 * 60 * 60 * 1000],
    ['非數值', 'now'],
  ])('t 為%s時丟棄', (_label, t) => {
    expect(normalizeActivityEvents([{ ...base, t, type: 'vis', state: 'visible' }])).toEqual([]);
  });

  it('t 在容許範圍邊緣內仍保留', () => {
    const events = [now + 23 * 60 * 60 * 1000, now - 6 * 24 * 60 * 60 * 1000].map((t) => ({ ...base, t, type: 'vis', state: 'visible' }));
    expect(normalizeActivityEvents(events)).toHaveLength(2);
  });
});
