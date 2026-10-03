/**
 * 出口標示的 meta 值由主機腳本寫入 Suwayomi，MoonTVPlus 只讀。
 * 壞資料必須回 null（面板不顯示），不能讓管理面板的來源列表整個掛掉。
 */
import { parseMangaSourceEgress } from '@/lib/manga.types';

describe('parseMangaSourceEgress', () => {
  it('解析腳本寫入的格式，丟掉不合格的主機項目', () => {
    const raw = JSON.stringify({
      route: 'mixed',
      hosts: [
        { host: 'tw.twmanga.com', route: 'warp', directMs: 710, warpMs: 330 },
        { host: 's1.bzcdn.net', route: 'direct' },
        { host: 'bad.example', route: 'tor' },
        'garbage',
      ],
      updatedAt: 1791043200000,
    });
    expect(parseMangaSourceEgress(raw)).toEqual({
      route: 'mixed',
      hosts: [
        { host: 'tw.twmanga.com', route: 'warp', directMs: 710, warpMs: 330 },
        { host: 's1.bzcdn.net', route: 'direct' },
      ],
      updatedAt: 1791043200000,
    });
  });

  it('壞 JSON、未知路由、非物件都回 null', () => {
    expect(parseMangaSourceEgress('{oops')).toBeNull();
    expect(
      parseMangaSourceEgress(JSON.stringify({ route: 'proxy', hosts: [] }))
    ).toBeNull();
    expect(parseMangaSourceEgress('"warp"')).toBeNull();
    expect(parseMangaSourceEgress(undefined)).toBeNull();
  });
});
