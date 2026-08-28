import {
  MAX_PAGE,
  parseMangaPage,
  parseMangaSourceIds,
} from '@/lib/manga-search-params';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('parseMangaSourceIds', () => {
  it('無參數時回空陣列（代表全部來源）', () => {
    expect(parseMangaSourceIds(params(''))).toEqual([]);
  });

  it('支援新的逗號分隔 sourceIds', () => {
    expect(parseMangaSourceIds(params('sourceIds=a,b,c'))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('相容舊的單值 sourceId', () => {
    expect(parseMangaSourceIds(params('sourceId=a'))).toEqual(['a']);
  });

  it('兩種參數同時出現時合併，sourceIds 優先排前', () => {
    expect(parseMangaSourceIds(params('sourceId=z&sourceIds=a,b'))).toEqual([
      'a',
      'b',
      'z',
    ]);
  });

  it('支援重複的參數鍵', () => {
    expect(parseMangaSourceIds(params('sourceIds=a&sourceIds=b'))).toEqual([
      'a',
      'b',
    ]);
  });

  it('去重且保留首次出現順序', () => {
    expect(parseMangaSourceIds(params('sourceIds=b,a,b,a'))).toEqual(['b', 'a']);
  });

  it('修掉空白並丟掉空片段', () => {
    expect(parseMangaSourceIds(params('sourceIds=%20a%20,,%20,b'))).toEqual([
      'a',
      'b',
    ]);
  });

  it('只有分隔符時視為未指定', () => {
    expect(parseMangaSourceIds(params('sourceIds=,,,'))).toEqual([]);
  });
});

/*
 * parseMangaPage 是 /api/manga/recommend、/api/manga/search 與
 * /api/manga/search/ws 三條 route 共用的信任邊界 —— page 會原樣進
 * GraphQL variables，而後兩條是對所有啟用來源 fan-out。
 *
 * 它刻意把失敗分成兩種：invalid（呼叫端給了壞格式，該回 400）與
 * exhausted（超出願意轉發的頁數，該回空結果）。回錯會有具體後果：
 * exhausted 誤回 400 會讓前端的載入更多陷入重打迴圈。
 */
describe('parseMangaPage', () => {
  it('缺省視為第 1 頁', () => {
    expect(parseMangaPage(null)).toEqual({ ok: true, page: 1 });
    expect(parseMangaPage('')).toEqual({ ok: true, page: 1 });
  });

  it('接受合法頁碼', () => {
    expect(parseMangaPage('1')).toEqual({ ok: true, page: 1 });
    expect(parseMangaPage('7')).toEqual({ ok: true, page: 7 });
  });

  it.each([
    ['0', '0'],
    ['負數', '-1'],
    ['小數', '1.5'],
    ['NaN', 'NaN'],
    ['非數字', 'abc'],
    ['Infinity', 'Infinity'],
  ])('%s → invalid（該回 400）', (_label, raw) => {
    expect(parseMangaPage(raw)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('超出上限 → exhausted（該回空結果，不是 400）', () => {
    // 誤回 400 的後果不是理論性的：前端的哨兵仍在視窗內，
    // 會重新 observe → 再打 → 再 400，形成重打迴圈
    expect(parseMangaPage(String(MAX_PAGE + 1))).toEqual({
      ok: false,
      reason: 'exhausted',
    });
    expect(parseMangaPage(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });

  it('恰好等於上限必須被接受（釘住邊界方向）', () => {
    // 只測 MAX_PAGE + 1 被拒的話，把 `value > MAX_PAGE` 改成 `>=`
    // 不會有任何測試失敗，實際上限卻靜默少一頁
    expect(parseMangaPage(String(MAX_PAGE))).toEqual({
      ok: true,
      page: MAX_PAGE,
    });
  });

  it('Number() 的非正規表示法落在合法區間內就接受', () => {
    // 記錄既有行為：這些都不是漏洞，只是接受了非正規寫法
    expect(parseMangaPage('1e3')).toEqual({ ok: true, page: 1000 });
    expect(parseMangaPage(' 2 ')).toEqual({ ok: true, page: 2 });
    expect(parseMangaPage('0x10')).toEqual({ ok: true, page: 16 });
  });
});
