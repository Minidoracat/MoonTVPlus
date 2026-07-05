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
  beforeEach(() => {
    jest.clearAllMocks();
    (getConfig as jest.Mock).mockResolvedValue({
      SiteConfig: { TMDBApiKey: '', TMDBReverseProxy: '' },
    });
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
});
