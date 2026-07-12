import { getTMDBHotList } from '@/lib/tmdb.client';

// jsdom 测试环境没有 AbortSignal.timeout（universalFetch 依赖）
if (typeof AbortSignal.timeout !== 'function') {
  (AbortSignal as unknown as Record<string, unknown>).timeout = (
    ms: number
  ) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}

// TMDB trending 固定 20 条/页；模拟第 N 页返回全局序号 (N-1)*20 .. (N-1)*20+19
jest.mock('node-fetch', () =>
  jest.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return {
      ok: true,
      json: async () => ({
        results: Array.from({ length: 20 }, (_, i) => {
          const globalIndex = (page - 1) * 20 + i;
          return {
            id: globalIndex,
            title: `影片${globalIndex}`,
            poster_path: `/p${globalIndex}.jpg`,
            vote_average: 8,
            release_date: '2026-01-01',
          };
        }),
      }),
    };
  })
);

describe('getTMDBHotList', () => {
  it('maps start/limit onto TMDB fixed 20-per-page pagination without gaps', async () => {
    // 第一页：全局 0..24（跨 TMDB 第 1、2 页）
    const first = await getTMDBHotList('key', 'movie', 'day', 0, 25);
    expect(first.code).toBe(200);
    expect(first.list).toHaveLength(25);
    expect(first.list[0].id).toBe('0');
    expect(first.list[24].id).toBe('24');

    // 第二页：全局 25..49（跨 TMDB 第 2、3 页，需正确偏移截取）
    const second = await getTMDBHotList('key', 'movie', 'day', 25, 25);
    expect(second.list).toHaveLength(25);
    expect(second.list[0].id).toBe('25');
    expect(second.list[24].id).toBe('49');
  });

  it('returns an error payload instead of throwing when TMDB fails', async () => {
    const nodeFetch = jest.requireMock('node-fetch') as jest.Mock;
    nodeFetch.mockResolvedValueOnce({ ok: false, status: 502 });

    const result = await getTMDBHotList('key', 'tv', 'week', 0, 25);
    expect(result.code).toBe(500);
    expect(result.list).toEqual([]);
  });
});
