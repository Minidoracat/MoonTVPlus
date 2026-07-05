import { titleMatchesSearchOrAlias } from '@/lib/search-title-match';

describe('titleMatchesSearchOrAlias', () => {
  it('keeps exact short alias matches', () => {
    expect(titleMatchesSearchOrAlias('功夫', '周星驰', ['功夫'], true)).toBe(true);
  });

  it('blocks broad short alias substring matches', () => {
    expect(titleMatchesSearchOrAlias('功夫小子闯佛山', '周星驰', ['功夫'], true)).toBe(false);
  });

  it('keeps longer alias substring matches for franchise titles', () => {
    expect(titleMatchesSearchOrAlias('蜘蛛侠：英雄无归', '蜘蛛人', ['蜘蛛侠'], true)).toBe(true);
  });
});
