import { act, renderHook } from '@testing-library/react';
import { setTimeout as sleep } from 'timers/promises';

import { useMangaChapterSummaryQueue } from '@/hooks/useMangaChapterSummaryQueue';

const mockFetchMangaChapterSummaries = jest.fn();

jest.mock('@/lib/db.client', () => ({
  fetchMangaChapterSummaries: (...args: unknown[]) =>
    mockFetchMangaChapterSummaries(...args),
}));

test('does not resend a failed summary key', async () => {
  let intersect: (element: Element) => void;
  jest.useFakeTimers();
  Object.defineProperty(global, 'IntersectionObserver', {
    configurable: true,
    value: jest.fn((callback: IntersectionObserverCallback) => {
      const observer = {
        observe: jest.fn(),
        unobserve: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as IntersectionObserver;
      intersect = (element) =>
        callback(
          [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
          observer
        );
      return observer;
    }),
  });

  mockFetchMangaChapterSummaries.mockRejectedValue(new Error('failed'));
  const { result } = renderHook(() =>
    useMangaChapterSummaryQueue({ onSummaries: jest.fn() })
  );
  const element = document.createElement('div');
  const item = { id: 'm1', sourceId: 's1' };
  const enterViewport = async () => {
    act(() => result.current.observe(element, item));
    await act(async () => {
      intersect(element);
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
  };

  await enterViewport();
  await enterViewport();
  await enterViewport();

  expect(mockFetchMangaChapterSummaries).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test('單本只在進到畫面後抓頁數，同時最多 2 本，已知頁數的不抓', async () => {
  let intersect: (elements: Element[]) => void = () => undefined;
  Object.defineProperty(global, 'IntersectionObserver', {
    configurable: true,
    value: jest.fn((callback: IntersectionObserverCallback) => {
      const observer = {
        observe: jest.fn(),
        unobserve: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as IntersectionObserver;
      intersect = (elements) =>
        callback(
          elements.map(
            (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry
          ),
          observer
        );
      return observer;
    }),
  });
  // 每次抓頁數都讓出一輪事件迴圈；限流壞掉的話，進行中的數量會超過 2
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = jest.fn(async (url: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(0);
    inFlight -= 1;
    const chapterId = new URL(url, 'http://localhost').searchParams.get('chapterId');
    return { ok: true, json: async () => ({ pages: chapterId === 'ch-a' ? ['p1'] : ['p1', 'p2', 'p3'] }) };
  });
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;

  try {
    const onPageCount = jest.fn();
    const { result } = renderHook(() =>
      useMangaChapterSummaryQueue({ onSummaries: jest.fn(), onPageCount })
    );
    const singles = ['a', 'b', 'c'].map((id) => ({
      id,
      sourceId: 's',
      latestChapterCount: 1,
      singleChapter: { id: `ch-${id}` },
    }));
    const known = {
      id: 'k',
      sourceId: 's',
      latestChapterCount: 1,
      singleChapter: { id: 'ch-k', pageCount: 30 },
    };
    const elements = [...singles, known].map(() => document.createElement('div'));
    act(() => {
      [...singles, known].forEach((item, i) => result.current.observe(elements[i], item));
    });

    act(() => intersect(elements));
    for (let tick = 0; tick < 10 && onPageCount.mock.calls.length < 3; tick += 1) {
      await act(async () => {
        await sleep(0);
      });
    }

    expect(maxInFlight).toBe(2);
    const fetchedIds = fetchMock.mock.calls.map(([url]) =>
      new URL(url, 'http://localhost').searchParams.get('chapterId')
    );
    expect(fetchedIds.sort()).toEqual(['ch-a', 'ch-b', 'ch-c']);
    expect(onPageCount).toHaveBeenCalledWith('s+a', 1);
    expect(onPageCount).toHaveBeenCalledWith('s+b', 3);
    expect(onPageCount).toHaveBeenCalledWith('s+c', 3);
  } finally {
    global.fetch = originalFetch;
  }
});
