import { act, renderHook } from '@testing-library/react';

import { useMangaChapterSummaryQueue } from '@/hooks/useMangaChapterSummaryQueue';

const mockFetchMangaChapterSummaries = jest.fn();

jest.mock('@/lib/db.client', () => ({
  fetchMangaChapterSummaries: (...args: unknown[]) =>
    mockFetchMangaChapterSummaries(...args),
}));

test('retries a failed summary key once', async () => {
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

  expect(mockFetchMangaChapterSummaries).toHaveBeenCalledTimes(2);
  jest.useRealTimers();
});
