import { parseMangaBrowseState } from './manga-browse-state';

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
