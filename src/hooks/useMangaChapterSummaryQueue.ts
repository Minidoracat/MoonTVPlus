'use client';

import { useCallback, useEffect, useRef } from 'react';

import { fetchMangaChapterSummaries } from '@/lib/db.client';
import type { MangaChapterSummary, MangaSearchItem } from '@/lib/manga.types';

type QueueItem = Pick<
  MangaSearchItem,
  'id' | 'sourceId' | 'latestChapterCount' | 'singleChapter'
>;

export type MangaChapterSummaries = Record<string, MangaChapterSummary>;

/** 單本頁數同時最多抓幾本：每本都要上游抓一次頁面清單（禁漫約 3 秒） */
const PAGE_COUNT_CONCURRENCY = 2;
// ponytail: 捲過頭的頁數工作最多排 12 個，超過丟最舊的（再進畫面會重排）；要更省就改成離開畫面即取消
const PAGE_COUNT_QUEUE_MAX = 12;

/** 還沒有頁數、也還沒排過的單本 → 回傳那一話的 id */
function pendingPageChapter(item: QueueItem, requested: Set<string>): string | null {
  const chapter = item.singleChapter;
  if (!chapter || chapter.pageCount !== undefined) return null;
  return requested.has(chapter.id) ? null : chapter.id;
}

/**
 * 卡片進到畫面附近才補章節摘要；單本（只有一話）再補頁數，讓人判斷值不值得點。
 * 頁數走 /api/manga/pages：抓到的清單同時進伺服器的內頁快取，點進去閱讀直接用；
 * Suwayomi 也會記住頁數，之後列表查詢就直接帶出來，不必再抓。
 */
export function useMangaChapterSummaryQueue({
  onSummaries,
  onPageCount,
}: {
  onSummaries: (summaries: MangaChapterSummaries) => void;
  /** 單本頁數抓到了；key 是 `${sourceId}+${mangaId}` */
  onPageCount?: (key: string, pageCount: number) => void;
}) {
  const onSummariesRef = useRef(onSummaries);
  const onPageCountRef = useRef(onPageCount);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedItemsRef = useRef(new Map<Element, QueueItem>());
  const observedElementsRef = useRef(new Map<string, Element>());
  const queuedRef = useRef(new Map<string, QueueItem>());
  const requestedRef = useRef(new Set<string>());
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const flushRef = useRef<() => void>(() => undefined);
  const pageQueueRef = useRef<Array<{ key: string; chapterId: string }>>([]);
  const pageRequestedRef = useRef(new Set<string>());
  const pageActiveRef = useRef(0);
  const pageControllerRef = useRef<AbortController | null>(null);
  const pumpPagesRef = useRef<() => void>(() => undefined);
  onSummariesRef.current = onSummaries;
  onPageCountRef.current = onPageCount;

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null || controllerRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, 300);
  }, []);

  flushRef.current = () => {
    if (controllerRef.current || queuedRef.current.size === 0) return;
    const batch = Array.from(queuedRef.current.values()).slice(0, 30);
    for (const item of batch) {
      queuedRef.current.delete(`${item.sourceId}+${item.id}`);
    }

    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    void fetchMangaChapterSummaries(
      batch.map((item) => ({ sourceId: item.sourceId, mangaId: item.id })),
      controller.signal
    )
      .then((summaries) => {
        if (!controller.signal.aborted && generation === generationRef.current) {
          onSummariesRef.current(summaries);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (generation === generationRef.current && queuedRef.current.size > 0) {
          scheduleFlush();
        }
      });
  };

  pumpPagesRef.current = () => {
    while (
      pageActiveRef.current < PAGE_COUNT_CONCURRENCY &&
      pageQueueRef.current.length > 0
    ) {
      // 後進先出：最後進到畫面附近的，最可能還在畫面上
      const job = pageQueueRef.current.pop();
      if (!job) break;
      const generation = generationRef.current;
      const controller = (pageControllerRef.current ??= new AbortController());
      pageActiveRef.current += 1;
      void fetch(`/api/manga/pages?chapterId=${encodeURIComponent(job.chapterId)}`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { pages?: unknown } | null) => {
          const pages = data?.pages;
          const pageCount = Array.isArray(pages) ? pages.length : 0;
          if (pageCount > 0 && generation === generationRef.current) {
            onPageCountRef.current?.(job.key, pageCount);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          // reset 已把計數歸零，舊一輪的完成不能再扣
          if (generation !== generationRef.current) return;
          pageActiveRef.current -= 1;
          pumpPagesRef.current();
        });
    }
  };

  const observe = useCallback((element: HTMLElement | null, item: QueueItem) => {
    const key = `${item.sourceId}+${item.id}`;
    const previous = observedElementsRef.current.get(key);
    if (previous && previous !== element) {
      observerRef.current?.unobserve(previous);
      observedItemsRef.current.delete(previous);
    }
    const wanted =
      item.latestChapterCount === undefined ||
      pendingPageChapter(item, pageRequestedRef.current) !== null;
    if (!element || !wanted) {
      // 同一個元素已不需要時也要停止觀察，否則之後進畫面會拿舊 item 再排一次
      if (previous === element && element) {
        observerRef.current?.unobserve(element);
        observedItemsRef.current.delete(element);
      }
      observedElementsRef.current.delete(key);
      return;
    }

    observedElementsRef.current.set(key, element);
    observedItemsRef.current.set(element, item);
    observerRef.current?.observe(element);
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
    queuedRef.current.clear();
    requestedRef.current.clear();
    pageControllerRef.current?.abort();
    pageControllerRef.current = null;
    pageQueueRef.current = [];
    pageRequestedRef.current.clear();
    pageActiveRef.current = 0;
    observerRef.current?.disconnect();
    observedItemsRef.current.clear();
    observedElementsRef.current.clear();
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = observedItemsRef.current.get(entry.target);
          if (!item) continue;

          const key = `${item.sourceId}+${item.id}`;
          observer.unobserve(entry.target);
          observedItemsRef.current.delete(entry.target);
          if (observedElementsRef.current.get(key) === entry.target) {
            observedElementsRef.current.delete(key);
          }
          if (item.latestChapterCount === undefined) {
            if (!requestedRef.current.has(key)) {
              requestedRef.current.add(key);
              queuedRef.current.set(key, item);
            }
            continue;
          }
          const chapterId = pendingPageChapter(item, pageRequestedRef.current);
          if (!chapterId) continue;
          pageRequestedRef.current.add(chapterId);
          pageQueueRef.current.push({ key, chapterId });
          if (pageQueueRef.current.length > PAGE_COUNT_QUEUE_MAX) {
            const dropped = pageQueueRef.current.shift();
            if (dropped) pageRequestedRef.current.delete(dropped.chapterId);
          }
        }
        if (queuedRef.current.size > 0) scheduleFlush();
        pumpPagesRef.current();
      },
      { rootMargin: '300px' }
    );
    observerRef.current = observer;
    observedItemsRef.current.forEach((_item, element) => {
      observer.observe(element);
    });

    return () => {
      reset();
      observerRef.current = null;
    };
  }, [reset, scheduleFlush]);

  return { observe, reset };
}
