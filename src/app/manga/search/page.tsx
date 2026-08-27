'use client';

import { Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';
import { deleteMangaShelf, getAllMangaShelf, saveMangaShelf } from '@/lib/db.client';
import {
  readMangaSourceHealth,
  recordMangaSourceHealth,
  type MangaSourceHealth,
} from '@/lib/manga-source-health';
import { MangaSearchItem, MangaShelfItem, MangaSource } from '@/lib/manga.types';

import MangaCard from '@/components/MangaCard';
import MangaSourceMultiPicker from '@/components/manga/MangaSourceMultiPicker';

const MANGA_SEARCH_STATE_KEY = 'manga_search_state';

function MangaCardSkeleton({ withButton = false }: { withButton?: boolean }) {
  return (
    <div className='space-y-2'>
      <div className='overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950'>
        <div className='aspect-[3/4] w-full animate-pulse bg-gray-200 dark:bg-gray-800' />
        <div className='space-y-3 p-3'>
          <div className='h-4 w-3/4 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
          <div className='h-3 w-1/2 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
        </div>
      </div>
      {withButton && <div className='h-9 w-full animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800' />}
    </div>
  );
}

export default function MangaSearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q')?.trim() || '';
  const urlSourceId = searchParams.get('sourceIds') || searchParams.get('sourceId') || '';

  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<MangaSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [results, setResults] = useState<MangaSearchItem[]>([]);
  const [shelf, setShelf] = useState<Record<string, MangaShelfItem>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [lastSearchedQuery, setLastSearchedQuery] = useState('');
  const [lastSearchedSourceId, setLastSearchedSourceId] = useState('');
  const restoredRef = useRef(false);
  const forceNextUrlSearchRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  /**
   * 每次搜尋單調遞增。不可用 `sourceId::query` 當識別：對同一組條件
   * 重新搜尋時新舊 generation 的 key 相同，舊流殘留的 message/error
   * 會通過檢查，把新搜尋誤報成「連線中斷」並關掉新流。
   */
  const searchGenerationRef = useRef(0);
  const pendingResultsRef = useRef<MangaSearchItem[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const [totalSources, setTotalSources] = useState(0);
  const [completedSources, setCompletedSources] = useState(0);
  const [useFluidSearch, setUseFluidSearch] = useState(true);
  const [sourceHealth, setSourceHealth] = useState<Record<string, MangaSourceHealth>>({});
  const pendingHealthRef = useRef<
    Array<{ sourceId: string; elapsedMs?: number; failed: boolean }>
  >([]);
  const [maxSources, setMaxSources] = useState<number | undefined>(undefined);

  useEffect(() => {
    setSourceHealth(readMangaSourceHealth());
  }, []);
  /**
   * 搜尋結果**不做客戶端持久化快取**。
   *
   * 先前有兩個 sessionStorage store（結果快取與整份 search state）存的都是
   * 「經過伺服器授權才拿到的內容」，key 只有來源與關鍵字。於是停用來源後、
   * 撤銷漫畫權限後、或同一分頁登出 A 換 B，舊結果都會在任何 API 授權檢查
   * **之前**被重播出來。
   *
   * 這件事無法用 key 修好：加使用者名稱擋不住「同一人、來源剛被停用」；
   * 加政策版本也只在頁面載入時取一次；改成「先畫快取再打 API 覆蓋」則會
   * 短暫顯示剛被封鎖的內容 —— 對成人來源屏蔽而言那已經是繞過。
   *
   * 所以只保留「關鍵字與來源選擇」這類非授權的 UI 狀態，
   * 速度改由伺服器端快取（getRecommendedManga 的政策無關快取）與
   * SSE 逐源串流提供 —— 那兩者都在授權之後。
   */
  const saveSearchState = useCallback(
    (nextState: { query: string; sourceId: string }) => {
      if (typeof window === 'undefined') return;
      try {
        sessionStorage.setItem(
          MANGA_SEARCH_STATE_KEY,
          JSON.stringify({ query: nextState.query, sourceId: nextState.sourceId })
        );
      } catch {
        // ignore session cache failures
      }
    },
    []
  );

  const restoreSearchState = useCallback(() => {
    if (typeof window === 'undefined') return null;
    try {
      const cached = sessionStorage.getItem(MANGA_SEARCH_STATE_KEY);
      if (!cached) return null;
      const parsed = JSON.parse(cached) as { query?: string; sourceId?: string };
      return { query: parsed.query || '', sourceId: parsed.sourceId || '' };
    } catch {
      return null;
    }
  }, []);

  const readFluidSearchSetting = useCallback(() => {
    if (typeof window === 'undefined') return true;
    try {
      const savedFluidSearch = localStorage.getItem('fluidSearch');
      if (savedFluidSearch !== null) return JSON.parse(savedFluidSearch) !== false;
    } catch {
      // ignore invalid localStorage values
    }
    return (window as any).RUNTIME_CONFIG?.FLUID_SEARCH !== false;
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch {
        // ignore close failures
      }
      eventSourceRef.current = null;
    }
  }, []);

  const clearPendingResults = useCallback(() => {
    pendingResultsRef.current = [];
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const appendBufferedResults = useCallback((nextResults: MangaSearchItem[]) => {
    if (nextResults.length === 0) return;
    pendingResultsRef.current.push(...nextResults);
    if (!flushTimerRef.current) {
      flushTimerRef.current = window.setTimeout(() => {
        const toAppend = pendingResultsRef.current;
        pendingResultsRef.current = [];
        startTransition(() => {
          setResults((prev) => prev.concat(toAppend));
        });
        flushTimerRef.current = null;
      }, 80);
    }
  }, []);

  useEffect(() => {
    setUseFluidSearch(readFluidSearchSetting());

    fetch('/api/manga/sources')
      .then((res) => res.json())
      .then((data) => {
        setSources(data.sources || []);
        if (typeof data.maxSources === 'number' && data.maxSources > 0) {
          setMaxSources(data.maxSources);
        }
      })
      .catch(() => undefined);

    getAllMangaShelf().then(setShelf).catch(() => undefined);

    return () => {
      closeEventSource();
      clearPendingResults();
    };
  }, [clearPendingResults, closeEventSource, readFluidSearchSetting]);

  const performSearch = useCallback(
    async (keyword: string, selectedSourceId: string, options?: { forceRefresh?: boolean }) => {
      const trimmedQuery = keyword.trim();
      if (!trimmedQuery) return;
      const normalizedSourceId = selectedSourceId || '';
      const forceRefresh = options?.forceRefresh === true;

      closeEventSource();
      clearPendingResults();
      searchGenerationRef.current += 1;
      const generation = searchGenerationRef.current;
      // 上一輪被中斷時殘留的量測不可帶到這次：recordMangaSourceHealth
      // 會用當下時間當 measuredAt，等於把舊資料的 TTL 續命
      pendingHealthRef.current = [];

      setLoading(true);
      setError('');
      setHasSearched(true);
      setLastSearchedQuery(trimmedQuery);
      setLastSearchedSourceId(normalizedSourceId);
      setTotalSources(0);
      setCompletedSources(0);

      // 結果一律重新向伺服器取得。不從本地快取先畫 ——
      // 那會讓剛被停用的來源內容短暫顯示出來，等同繞過授權。
      setResults([]);

      const currentFluidSearch = readFluidSearchSetting();
      setUseFluidSearch((prev) => (prev === currentFluidSearch ? prev : currentFluidSearch));

      const params = new URLSearchParams({ q: trimmedQuery });
      if (normalizedSourceId) params.set('sourceIds', normalizedSourceId);

      if (currentFluidSearch) {
        // complete 時我們會主動 closeEventSource()，那會觸發 onerror；
        // 用這個旗標區分「正常結束」與「連線真的斷了」。
        let streamFinished = false;
        const es = new EventSource(`/api/manga/search/ws?${params.toString()}`);
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          if (!event.data || searchGenerationRef.current !== generation) return;
          try {
            const payload = JSON.parse(event.data);
            switch (payload.type) {
              case 'start':
                setTotalSources(payload.totalSources || 0);
                setCompletedSources(0);
                break;
              case 'source_result':
                setCompletedSources((prev) => Math.max(prev + 1, payload.completedSources || 0));
                pendingHealthRef.current.push({
                  sourceId: String(payload.sourceId || ''),
                  elapsedMs:
                    typeof payload.elapsedMs === 'number' ? payload.elapsedMs : undefined,
                  failed: false,
                });
                if (Array.isArray(payload.results) && payload.results.length > 0) {
                  appendBufferedResults(payload.results as MangaSearchItem[]);
                }
                break;
              case 'source_error':
                setCompletedSources((prev) => Math.max(prev + 1, payload.completedSources || 0));
                pendingHealthRef.current.push({
                  sourceId: String(payload.sourceId || ''),
                  failed: true,
                });
                break;
              case 'error':
                streamFinished = true;
                setError(payload.error || '搜索失败');
                setLoading(false);
                // 這一輪已結束，殘留量測不可留到下一次搜尋才落盤
                pendingHealthRef.current = [];
                closeEventSource();
                break;
              case 'complete': {
                streamFinished = true;
                setCompletedSources(payload.completedSources || payload.totalSources || 0);
                if (payload.allFailed) {
                  const first = Array.isArray(payload.failedSources)
                    ? payload.failedSources[0]
                    : undefined;
                  setError(
                    first
                      ? `所有来源都失败了，例如「${first.sourceName}」：${String(first.error).split('\n')[0].slice(0, 120)}`
                      : '所有来源都搜索失败'
                  );
                }
                if (pendingHealthRef.current.length > 0) {
                  const measured = pendingHealthRef.current;
                  pendingHealthRef.current = [];
                  setSourceHealth(recordMangaSourceHealth(measured));
                }
                // 全滅時不可寫入快取／搜尋狀態：否則下次同條件會命中快取直接
                // 提早返回，把「全部來源失敗」變成沒有錯誤的「沒有找到」
                const cacheable = !payload.allFailed;
                if (pendingResultsRef.current.length > 0) {
                  const toAppend = pendingResultsRef.current;
                  pendingResultsRef.current = [];
                  if (flushTimerRef.current) {
                    window.clearTimeout(flushTimerRef.current);
                    flushTimerRef.current = null;
                  }
                  startTransition(() => {
                    setResults((prev) => prev.concat(toAppend));
                  });
                }
                if (cacheable) {
                  // 只記關鍵字與來源選擇（非授權內容），供返回時還原輸入
                  saveSearchState({
                    query: trimmedQuery,
                    sourceId: normalizedSourceId,
                  });
                }
                setLoading(false);
                closeEventSource();
                break;
              }
            }
          } catch {
            // ignore malformed SSE payloads
          }
        };

        es.onerror = () => {
          if (searchGenerationRef.current !== generation) return;
          if (streamFinished) return;
          const hadPartial = pendingResultsRef.current.length > 0;
          if (hadPartial) {
            const toAppend = pendingResultsRef.current;
            pendingResultsRef.current = [];
            if (flushTimerRef.current) {
              window.clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            startTransition(() => {
              setResults((prev) => prev.concat(toAppend));
            });
          }
          // 連線層失敗（401、代理中斷、串流提前結束）不可偽裝成「沒有結果」
          setError('搜索连接中断，结果可能不完整，请重试');
          setLoading(false);
          // 中斷的量測丟棄，否則會在下一次成功搜尋時以新的 measuredAt 落盤
          pendingHealthRef.current = [];
          closeEventSource();
        };
        return;
      }

      try {
        const res = await fetch(`/api/manga/search?${params.toString()}`);
        const data = await res.json();
        if (searchGenerationRef.current !== generation) return;
        if (!res.ok) throw new Error(data.error || '搜索失败');
        const nextResults = data.results || [];
        if (data.allFailed) {
          const first = Array.isArray(data.failedSources)
            ? data.failedSources[0]
            : undefined;
          setError(
            first
              ? `所有来源都失败了，例如「${first.sourceName}」：${String(first.error).split('\n')[0].slice(0, 120)}`
              : '所有来源都搜索失败'
          );
        }
        // 非流式路徑同樣要累積來源健康度，否則關閉流式搜尋後速度標記永遠不更新
        if (Array.isArray(data.measurements) && data.measurements.length > 0) {
          setSourceHealth(recordMangaSourceHealth(data.measurements));
        }
        setResults(nextResults);
        setTotalSources(data.attemptedSources || 1);
        setCompletedSources(data.attemptedSources || 1);
        // 全滅不記狀態，否則返回時會還原成一個看起來正常的空搜尋
        if (!data.allFailed) {
          saveSearchState({
            query: trimmedQuery,
            sourceId: normalizedSourceId,
          });
        }
      } catch (err) {
        if (searchGenerationRef.current !== generation) return;
        setError((err as Error).message);
        setResults([]);
      } finally {
        if (searchGenerationRef.current === generation) {
          setLoading(false);
        }
      }
    },
    [
      appendBufferedResults,
      clearPendingResults,
      closeEventSource,
      readFluidSearchSetting,
      saveSearchState,
    ]
  );

  useEffect(() => {
    if (!restoredRef.current) {
      restoredRef.current = true;

      if (!urlQuery) {
        // 只還原輸入狀態；結果一律重新搜尋，不從本地重播
        const cachedState = restoreSearchState();
        if (cachedState?.query?.trim()) {
          setQuery(cachedState.query);
          setSourceId(cachedState.sourceId || '');
        }
        return;
      }
    }

    setQuery(urlQuery);
    setSourceId(urlSourceId);

    if (!urlQuery) {
      closeEventSource();
      clearPendingResults();
      setResults([]);
      setLoading(false);
      setHasSearched(false);
      setLastSearchedQuery('');
      setLastSearchedSourceId('');
      setTotalSources(0);
      setCompletedSources(0);
      setError('');
      return;
    }

    const forceRefresh = forceNextUrlSearchRef.current;
    forceNextUrlSearchRef.current = false;
    void performSearch(urlQuery, urlSourceId, { forceRefresh });
  }, [clearPendingResults, closeEventSource, performSearch, restoreSearchState, urlQuery, urlSourceId]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    const params = new URLSearchParams({ q: trimmedQuery });
    if (sourceId) params.set('sourceId', sourceId);
    const nextUrl = `/manga/search?${params.toString()}`;
    if (urlQuery === trimmedQuery && urlSourceId === sourceId) {
      await performSearch(trimmedQuery, sourceId, { forceRefresh: true });
    } else {
      forceNextUrlSearchRef.current = true;
      router.replace(nextUrl);
    }
  };

  const returnTo = useMemo(() => {
    const params = new URLSearchParams();
    if (lastSearchedQuery) params.set('q', lastSearchedQuery);
    if (lastSearchedSourceId) params.set('sourceId', lastSearchedSourceId);
    const queryString = params.toString();
    return queryString ? `/manga/search?${queryString}` : '/manga/search';
  }, [lastSearchedQuery, lastSearchedSourceId]);

  const toggleShelf = async (item: MangaSearchItem) => {
    const key = `${item.sourceId}+${item.id}`;
    if (shelf[key]) {
      await deleteMangaShelf(item.sourceId, item.id);
      setShelf((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    const shelfItem: MangaShelfItem = {
      title: item.title,
      cover: item.cover,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      mangaId: item.id,
      saveTime: Date.now(),
      description: item.description,
      author: item.author,
      status: item.status,
    };
    await saveMangaShelf(item.sourceId, item.id, shelfItem);
    setShelf((prev) => ({ ...prev, [key]: shelfItem }));
  };

  return (
    <div className='mx-auto max-w-6xl'>
      <form className='mx-auto mb-8 max-w-4xl' onSubmit={handleSearch}>
        <div className='flex flex-col gap-3 lg:flex-row'>
          <div className='flex-1'>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='搜索漫画标题'
              className='w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none transition focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900'
            />
          </div>
          <MangaSourceMultiPicker
            sources={sources}
            value={sourceId ? sourceId.split(',').filter(Boolean) : []}
            onChange={(ids) => setSourceId(ids.join(','))}
            health={sourceHealth}
            maxActive={maxSources}
            className='lg:w-64'
          />
          <button className='inline-flex items-center justify-center gap-2 rounded-2xl bg-sky-600 px-6 py-3 text-sm font-medium text-white transition hover:bg-sky-700 lg:w-32'>
            <Search className='h-4 w-4' /> 搜索
          </button>
        </div>
      </form>

      <section>
        <div className='mb-4 flex items-center justify-between gap-3'>
          <h2 className='text-lg font-semibold'>搜索结果{results.length > 0 ? `（${results.length}）` : ''}</h2>
          {loading && useFluidSearch && totalSources > 0 && (
            <span className='text-xs text-gray-500 dark:text-gray-400'>
              搜索中 {completedSources}/{totalSources}
            </span>
          )}
        </div>
        {error && <div className='mb-4 text-sm text-red-500'>{error}</div>}
        {loading && results.length === 0 ? (
          <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
            {Array.from({ length: 12 }).map((_, index) => (
              <MangaCardSkeleton key={index} withButton />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className='rounded-2xl bg-gray-50 p-10 text-center text-sm text-gray-500 dark:bg-gray-900/50'>
            {hasSearched ? '没有找到相关漫画' : '请输入关键词开始搜索漫画'}
          </div>
        ) : (
          <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
            {results.map((item) => {
              const key = `${item.sourceId}+${item.id}`;
              return (
                <div key={key} className='space-y-2'>
                  <MangaCard
                    item={item}
                    href={`/manga/detail?mangaId=${item.id}&sourceId=${item.sourceId}&title=${encodeURIComponent(item.title)}&cover=${encodeURIComponent(item.cover)}&sourceName=${encodeURIComponent(item.sourceName)}&description=${encodeURIComponent(item.description || '')}&author=${encodeURIComponent(item.author || '')}&status=${encodeURIComponent(item.status || '')}&returnTo=${encodeURIComponent(returnTo)}`}
                    subtitle={item.author || item.status || item.description}
                  />
                  <button
                    onClick={() => toggleShelf(item)}
                    className='w-full rounded-2xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-sky-500 hover:text-sky-600 dark:border-gray-700 dark:text-gray-200'
                  >
                    {shelf[key] ? '移出书架' : '加入书架'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
