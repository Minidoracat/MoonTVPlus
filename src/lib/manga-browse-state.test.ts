import { appendUniqueMangas, parseMangaBrowseState } from './manga-browse-state';

const state = {
  listHref: '/manga?sourceId=1&type=POPULAR',
  keyword: '',
  filterSelections: [],
  page: 2,
  mangas: [
    {
      id: '10',
      sourceId: '1',
      sourceName: '來源',
      title: '漫畫',
      cover: '/cover.jpg',
    },
  ],
  hasNextPage: true,
  scrollY: 100,
};

it('只還原十分鐘內且帶時間戳的瀏覽狀態', () => {
  expect(
    parseMangaBrowseState(JSON.stringify({ ...state, savedAt: Date.now() }))
  ).toMatchObject(state);
  expect(
    parseMangaBrowseState(
      JSON.stringify({ ...state, savedAt: Date.now() - 10 * 60_000 - 1 })
    )
  ).toBeNull();
  expect(parseMangaBrowseState(JSON.stringify(state))).toBeNull();
});

describe('appendUniqueMangas', () => {
  const item = (id: string, sourceId = '1') => ({
    id,
    sourceId,
    sourceName: '來源',
    title: `漫畫 ${id}`,
    cover: '',
  });

  it('跨頁與同頁重複都只保留第一次出現，順序不變', () => {
    const { mangas, added } = appendUniqueMangas(
      [item('a'), item('b')],
      [item('b'), item('c'), item('c'), item('a', '2')]
    );
    expect(mangas.map((m) => `${m.sourceId}+${m.id}`)).toEqual([
      '1+a',
      '1+b',
      '1+c',
      '2+a',
    ]);
    expect(added).toBe(2);
  });

  it('整頁都重複時 added 為 0，呼叫端才能停止翻頁', () => {
    expect(appendUniqueMangas([item('a')], [item('a')]).added).toBe(0);
  });
});
