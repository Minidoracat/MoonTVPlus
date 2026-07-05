import { getConfig } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { resolveTitleAliases } from '@/lib/title-alias';

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

  it('expands actor or director names to TMDB known works', async () => {
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

    await expect(resolveTitleAliases('周星驰')).resolves.toEqual([
      '功夫',
      '少林足球',
      '食神',
      '盖世豪侠',
      'Kung Fu Hustle',
    ]);
  });
});
