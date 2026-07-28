import {
  getDoubanDetail,
  getDoubanRecommends,
  NETFLIX_MOVIE_RECOMMEND_PARAMS,
} from '@/lib/douban.client';

describe('getDoubanDetail', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('doubanDataSource', 'direct');
    localStorage.setItem('doubanDataSourceBackup', 'direct');
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('can suppress the global error toast when caller will fall back', async () => {
    const listener = jest.fn();
    window.addEventListener('globalError', listener);

    await expect(
      getDoubanDetail('1292052', { suppressGlobalError: true })
    ).rejects.toThrow('HTTP error');

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('globalError', listener);
  });
});

describe('getDoubanRecommends - Netflix 电影预设', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('direct 路径不会把 undefined 拼进 query，且带上 platform=Netflix&sort=U', async () => {
    localStorage.clear();
    // 主备都设 direct：sameStrategy 分支直接 rethrow，保证只发生一次 fetch
    localStorage.setItem('doubanDataSource', 'direct');
    localStorage.setItem('doubanDataSourceBackup', 'direct');

    // 必须 ok:true，否则会走 fallback 而非要断言的成功路径
    const fetchMock = jest.fn(async (_input: string) => ({
      ok: true,
      json: async () => ({ code: 200, message: '', list: [] }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await getDoubanRecommends({
      ...NETFLIX_MOVIE_RECOMMEND_PARAMS,
      pageLimit: 25,
      pageStart: 25,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('kind=movie');
    expect(url).toContain('platform=Netflix');
    expect(url).toContain('sort=U');
    expect(url).toContain('start=25');
    expect(url).not.toContain('undefined');
  });

  // A10 等价性：Netflix preset 与"全部 + 平台=Netflix + 排序=近期热度"必须打同一个豆瓣 URL。
  // 注意覆盖边界：本测试直接调 getDoubanRecommends，不经过 page.tsx 的两个分支，
  // 下面第二组参数是"全部"分支传参的手抄副本。它锁的是 preset 与该副本的等价语义，
  // 页面两处调用点的一致性靠双方 spread 同一常数保证，不靠这个测试。
  // 改动 page.tsx 的"全部"分支传参时，需同步更新下面的副本。
  it('与"全部 + 平台=Netflix + 排序=近期热度"打出的上游 URL 逐字符相同', async () => {
    localStorage.clear();
    // 走 CDN 代理模式，上游 URL 才在客户端拼出来、可被 mock 捕获
    localStorage.setItem('doubanDataSource', 'cmliussss-cdn-tencent');
    localStorage.setItem('doubanDataSourceBackup', 'cmliussss-cdn-tencent');

    const fetchMock = jest.fn(async (_input: string) => ({
      ok: true,
      json: async () => ({ items: [] }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await getDoubanRecommends({
      ...NETFLIX_MOVIE_RECOMMEND_PARAMS,
      pageLimit: 25,
      pageStart: 0,
    });

    // 电影页"全部"分支的实际传参：multiLevelValues 默认为 all，format 对 movie 为空
    await getDoubanRecommends({
      kind: 'movie',
      pageLimit: 25,
      pageStart: 0,
      category: 'all',
      format: '',
      region: 'all',
      year: 'all',
      platform: 'Netflix',
      sort: 'U',
      label: 'all',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const netflixUrl = String(fetchMock.mock.calls[0][0]);
    const allWithFilterUrl = String(fetchMock.mock.calls[1][0]);
    expect(netflixUrl).toBe(allWithFilterUrl);
    expect(netflixUrl).toContain('tags=Netflix');
    expect(netflixUrl).toContain('sort=U');
  });
});
