'use client';

import { useCallback, useEffect, useRef } from 'react';

import { fetchMangaChapterSummaries } from '@/lib/db.client';
import type { MangaSearchItem } from '@/lib/manga.types';

type QueueItem = Pick<MangaSearchItem, 'id' | 'sourceId' | 'latestChapterCount'>;

export type MangaChapterSummaries = Record<
  string,
  { count: number; latestName?: string }
>;

export function useMangaChapterSummaryQueue({
  onSummaries,
}: {
  onSummaries: (summaries: MangaChapterSummaries) => void;
}) {
  const onSummariesRef = useRef(onSummaries);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedItemsRef = useRef(new Map<Element, QueueItem>());
  const observedElementsRef = useRef(new Map<string, Element>());
  const queuedRef = useRef(new Map<string, QueueItem>());
  const requestedRef = useRef(new Set<string>());
  const failedOnceRef = useRef(new Set<string>());
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const flushRef = useRef<() => void>(() => undefined);
  onSummariesRef.current = onSummaries;

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
          for (const item of batch) {
            const key = `${item.sourceId}+${item.id}`;
            if (summaries[key] || failedOnceRef.current.has(key)) continue;
            failedOnceRef.current.add(key);
            requestedRef.current.delete(key);
          }
          onSummariesRef.current(summaries);
        }
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== generationRef.current)
          return;
        for (const item of batch) {
          const key = `${item.sourceId}+${item.id}`;
          if (failedOnceRef.current.has(key)) continue;
          failedOnceRef.current.add(key);
          requestedRef.current.delete(key);
        }
      })
      .finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (generation === generationRef.current && queuedRef.current.size > 0) {
          scheduleFlush();
        }
      });
  };

  const observe = useCallback(
    (element: HTMLElement | null, item: QueueItem) => {
      const key = `${item.sourceId}+${item.id}`;
      const previous = observedElementsRef.current.get(key);
      if (previous && previous !== element) {
        observerRef.current?.unobserve(previous);
        observedItemsRef.current.delete(previous);
      }
      if (!element || item.latestChapterCount !== undefined) {
        observedElementsRef.current.delete(key);
        return;
      }

      observedElementsRef.current.set(key, element);
      observedItemsRef.current.set(element, item);
      observerRef.current?.observe(element);
    },
    []
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
    queuedRef.current.clear();
    requestedRef.current.clear();
    failedOnceRef.current.clear();
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
          if (
            item.latestChapterCount !== undefined ||
            requestedRef.current.has(key)
          ) {
            continue;
          }
          requestedRef.current.add(key);
          queuedRef.current.set(key, item);
        }
        if (queuedRef.current.size > 0) scheduleFlush();
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
