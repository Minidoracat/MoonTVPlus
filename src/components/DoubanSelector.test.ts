import {
  buildNetflixSecondary,
  NETFLIX_SOURCE_DOUBAN,
  NETFLIX_SOURCE_OFFICIAL,
  parseNetflixSecondary,
} from './DoubanSelector';

describe('netflix 二级编解码', () => {
  it('三个维度可往返', () => {
    const s = buildNetflixSecondary(
      NETFLIX_SOURCE_OFFICIAL,
      'JP',
      '2026-07-26'
    );
    expect(parseNetflixSecondary(s)).toEqual({
      source: NETFLIX_SOURCE_OFFICIAL,
      region: 'JP',
      week: '2026-07-26',
    });
  });

  it('官方周榜未选周次时编成空周次，解回空字串', () => {
    const s = buildNetflixSecondary(NETFLIX_SOURCE_OFFICIAL, 'TW', '');
    expect(s).toBe('official-top10:TW:');
    expect(parseNetflixSecondary(s)).toEqual({
      source: NETFLIX_SOURCE_OFFICIAL,
      region: 'TW',
      week: '',
    });
  });

  it('豆瓣热度不带地区/周次，避免残值污染', () => {
    expect(
      buildNetflixSecondary(NETFLIX_SOURCE_DOUBAN, 'JP', '2026-07-26')
    ).toBe(NETFLIX_SOURCE_DOUBAN);
  });

  it('残留的豆瓣二级值降级为豆瓣热度、地区回落台湾', () => {
    expect(parseNetflixSecondary('全部')).toEqual({
      source: NETFLIX_SOURCE_DOUBAN,
      region: 'TW',
      week: '',
    });
    expect(parseNetflixSecondary(undefined)).toEqual({
      source: NETFLIX_SOURCE_DOUBAN,
      region: 'TW',
      week: '',
    });
  });
});
