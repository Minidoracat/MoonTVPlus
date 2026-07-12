import { getConfig } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { searchFromApi } from '@/lib/downstream';
import {
  resolveTitleAliases,
  searchFromApiWithQueries,
} from '@/lib/title-alias';

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
}));

jest.mock('@/lib/douban', () => ({
  fetchDoubanData: jest.fn(),
}));

jest.mock('@/lib/downstream', () => ({
  searchFromApi: jest.fn(),
}));

describe('resolveTitleAliases', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
    (getConfig as jest.Mock).mockResolvedValue({
      SiteConfig: { TMDBApiKey: '', TMDBReverseProxy: '' },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('prefers the candidate whose aka exactly matches the query', async () => {
    (fetchDoubanData as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('subject_suggest')) {
        return [
          { id: 'wrong', title: '变形蜘蛛人', year: '2001' },
          { id: 'spider-man', title: '蜘蛛侠', year: '2002' },
        ];
      }
      if (url.includes('/wrong')) {
        return { title: '变形蜘蛛人', aka: ['Earth vs. Spider'] };
      }
      if (url.includes('/spider-man')) {
        return { title: '蜘蛛侠', aka: ['蜘蛛人(台)', 'Spider-Man'] };
      }
      return {};
    });

    await expect(resolveTitleAliases('蜘蛛人')).resolves.toEqual([
      '蜘蛛侠',
      '蜘蛛俠',
      'Spider-Man',
    ]);
  });

  it('keeps useful regional title variants when Douban suggests the wrong subject', async () => {
    (fetchDoubanData as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('subject_suggest')) {
        return [{ id: 'wrong', title: '变形钢铁人', year: '2001' }];
      }
      return { title: '变形钢铁人', aka: ['Iron Mutant'] };
    });

    await expect(resolveTitleAliases('钢铁人')).resolves.toEqual([
      '钢铁侠',
      '钢铁俠',
      '变形钢铁人',
      'Iron Mutant',
    ]);
  });

  it('returns no aliases in title mode when Douban suggests a celebrity first', async () => {
    (fetchDoubanData as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('subject_suggest')) {
        return [
          { id: '1048026', title: '梁朝伟', type: 'celebrity' },
          { id: '1297747', title: '花样年华', year: '2000', type: 'movie' },
        ];
      }
      return { title: '花样年华', aka: ['In the Mood for Love'] };
    });

    await expect(resolveTitleAliases('梁朝伟')).resolves.toEqual([]);
  });

  it('does not expand actor or director names in title mode', async () => {
    (getConfig as jest.Mock).mockResolvedValue({
      SiteConfig: {
        TMDBApiKey: 'tmdb-key',
        TMDBReverseProxy: 'https://tmdb.example',
      },
    });
    (fetchDoubanData as jest.Mock).mockResolvedValue([]);
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/search/multi')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 42,
                media_type: 'person',
                name: '周星驰',
                known_for: [
                  {
                    id: 1,
                    media_type: 'movie',
                    title: '功夫',
                    original_title: 'Kung Fu Hustle',
                    popularity: 90,
                  },
                ],
              },
            ],
          }),
        };
      }

      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    await expect(resolveTitleAliases('周星驰')).resolves.toEqual([]);
  });

  it('expands actor or director names to TMDB known works in person mode', async () => {
    (getConfig as jest.Mock).mockResolvedValue({
      SiteConfig: {
        TMDBApiKey: 'tmdb-key',
        TMDBReverseProxy: 'https://tmdb.example',
      },
    });
    (fetchDoubanData as jest.Mock).mockResolvedValue([]);
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/search/multi')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 42,
                media_type: 'person',
                name: '周星驰',
                known_for: [
                  {
                    id: 1,
                    media_type: 'movie',
                    title: '功夫',
                    original_title: 'Kung Fu Hustle',
                    popularity: 90,
                  },
                ],
              },
            ],
          }),
        };
      }

      if (url.includes('/person/42/combined_credits')) {
        return {
          ok: true,
          json: async () => ({
            cast: [
              {
                id: 2,
                media_type: 'movie',
                title: '少林足球',
                popularity: 80,
              },
              {
                id: 3,
                media_type: 'tv',
                name: '盖世豪侠',
                popularity: 70,
              },
            ],
            crew: [
              {
                id: 4,
                media_type: 'movie',
                title: '食神',
                popularity: 75,
              },
            ],
          }),
        };
      }

      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    await expect(resolveTitleAliases('周星驰', 'person')).resolves.toEqual([
      '功夫',
      '少林足球',
      '食神',
      '盖世豪侠',
      'Kung Fu Hustle',
    ]);
  });

  it('keeps up to 30 works in person mode instead of the title-mode cap of 5', async () => {
    (getConfig as jest.Mock).mockResolvedValue({
      SiteConfig: {
        TMDBApiKey: 'tmdb-key',
        TMDBReverseProxy: 'https://tmdb.example',
      },
    });
    (fetchDoubanData as jest.Mock).mockResolvedValue([]);
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/search/multi')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ id: 7, media_type: 'person', name: '刘德华' }],
          }),
        };
      }

      if (url.includes('/person/7/combined_credits')) {
        return {
          ok: true,
          json: async () => ({
            cast: Array.from({ length: 40 }, (_, i) => ({
              id: 100 + i,
              media_type: 'movie',
              title: `作品${i + 1}`,
              popularity: 100 - i,
            })),
          }),
        };
      }

      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    const aliases = await resolveTitleAliases('刘德华', 'person');
    expect(aliases).toHaveLength(30);
    expect(aliases[0]).toBe('作品1');
  });

  it('only briefly caches an empty person resolution so it retries soon after', async () => {
    jest.useFakeTimers();
    try {
      (getConfig as jest.Mock).mockResolvedValue({
        SiteConfig: {
          TMDBApiKey: 'tmdb-key',
          TMDBReverseProxy: 'https://tmdb.example',
        },
      });
      let tmdbUp = false;
      global.fetch = jest.fn(async (url: string) => {
        if (!tmdbUp) return { ok: false, status: 502 };
        if (url.includes('/search/multi')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ id: 9, media_type: 'person', name: '成龙' }],
            }),
          };
        }
        if (url.includes('/person/9/combined_credits')) {
          return {
            ok: true,
            json: async () => ({
              cast: [
                {
                  id: 90,
                  media_type: 'movie',
                  title: '警察故事',
                  popularity: 50,
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404 };
      }) as unknown as typeof fetch;

      // TMDB 挂了：解析为空
      await expect(resolveTitleAliases('成龙', 'person')).resolves.toEqual([]);

      // 负缓存窗口内：命中空缓存，不再请求 TMDB
      tmdbUp = true;
      const callsAfterFirst = (global.fetch as jest.Mock).mock.calls.length;
      await expect(resolveTitleAliases('成龙', 'person')).resolves.toEqual([]);
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(
        callsAfterFirst
      );

      // 超过负缓存 TTL（5 分钟）后重新解析成功，而非被 24h 长缓存卡住
      jest.advanceTimersByTime(6 * 60 * 1000);
      await expect(resolveTitleAliases('成龙', 'person')).resolves.toEqual([
        '警察故事',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('searchFromApiWithQueries', () => {
  const site = { key: 'demo', name: 'Demo', api: '' } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dedupes across batches via a shared seen set, returning only new results', async () => {
    (searchFromApi as jest.Mock).mockImplementation(async (_site, q: string) =>
      q === '功夫'
        ? [{ source: 'demo', id: '1', title: '功夫' }]
        : [{ source: 'demo', id: '2', title: '少林足球' }]
    );

    const seen = new Set<string>();
    const first = await searchFromApiWithQueries(site, ['功夫', '少林足球'], seen);
    expect(first.map((r) => r.id)).toEqual(['1', '2']);

    (searchFromApi as jest.Mock).mockResolvedValue([
      { source: 'demo', id: '1', title: '功夫' },
      { source: 'demo', id: '3', title: '食神' },
    ]);

    const second = await searchFromApiWithQueries(site, ['食神'], seen);
    expect(second.map((r) => r.id)).toEqual(['3']);
  });

  it('registers results into seen even for a single-query batch', async () => {
    (searchFromApi as jest.Mock).mockResolvedValue([
      { source: 'demo', id: '9', title: '九品芝麻官' },
    ]);

    const seen = new Set<string>();
    const first = await searchFromApiWithQueries(site, ['九品芝麻官'], seen);
    expect(first.map((r) => r.id)).toEqual(['9']);

    // 下一批命中同一条结果时应被 seen 过滤
    const second = await searchFromApiWithQueries(site, ['九品芝麻官 国语'], seen);
    expect(second).toEqual([]);
  });
});
