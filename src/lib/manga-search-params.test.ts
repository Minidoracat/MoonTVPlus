import { parseMangaSourceIds } from '@/lib/manga-search-params';

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
