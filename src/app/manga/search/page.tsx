'use client';

import { Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  deleteMangaShelf,
  getAllMangaShelf,
  saveMangaShelf,
} from '@/lib/db.client';
import {
  type MangaSearchFailure,
  type MangaSourceProbeSummary,
  isAllMangaSourcesFailed,
  MangaSearchItem,
  MangaShelfItem,
  MangaSource,
} from '@/lib/manga.types';
import {
  type MangaCreatorFilter,
  type MangaCreatorRole,
  type MangaResultSort,
  type MangaSearchBatch,
  buildSourceBuckets,
  getMangaCreatorGroups,
  groupResultsBySource,
  MANGA_RESULT_RENDER_PAGE_SIZE,
  planMangaSearchBatches,
  selectVisibleResults,
} from '@/lib/manga-search-view';
import {
  type MangaSourceHealth,
  type MangaSourceHealthEntry,
  formatMangaSearchStatus,
  readMangaSourceHealth,
  recordMangaSourceHealth,
} from '@/lib/manga-source-health';
import { useMangaChapterSummaryQueue } from '@/hooks/useMangaChapterSummaryQueue';

import MangaSourceMultiPicker from '@/components/manga/MangaSourceMultiPicker';
import MangaCard from '@/components/MangaCard';

const MANGA_SEARCH_STATE_KEY = 'manga_search_state';
const MANGA_SOURCE_PLAN_TIMEOUT_MS = 3000;

/*
 * 失敗來源的形狀直接沿用後端的 MangaSearchFailure，不在這裡另立一份。
 *
 * 先前這裡自訂了一個同名同形的 interface，其中 timedOut 寫成 optional ——
 * 而後端當時根本沒有這個欄位，於是「含 N 个超时」恆為 0 而 tsc 全綠。
 * 共用同一個型別才會讓兩端漂移編不過。
 */

/**
 * 一個批次的結束方式。
 *
 * 序列批次必須能分辨三件事，否則會出現「停止後又發下一批」或「連線斷了卻
 * 當成這批沒有結果」：
 *   - complete：這批正常收尾，可以接著發下一批
 *   - error：傳輸層或伺服器層失敗，後續批次一律不發
 *   - aborted：使用者按停止或發起了新搜尋，這條路徑不碰任何畫面狀態
 */
type MangaSearchBatchOutcome =
  | {
      kind: 'complete';
      /** 這批實際查了幾顆來源（伺服器可能因政策砍掉幾顆） */
      attempted: number;
      failedCount: number;
      firstFailure?: MangaSearchFailure;
    }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

/** 兩條路徑（SSE／REST）的失敗來源要收斂成同一個形狀才能混在一份清單裡 */
function normalizeFailure(raw: {
  sourceId?: unknown;
  sourceName?: unknown;
  error?: unknown;
  timedOut?: unknown;
}): MangaSearchFailure {
  return {
    sourceId: String(raw.sourceId || ''),
    sourceName: String(raw.sourceName || raw.sourceId || '未知来源'),
    error: String(raw.error || '搜索失败')
      .split('\n')[0]
      .slice(0, 160),
    timedOut: raw.timedOut === true,
  };
}

/**
 * 一批要送出的 query string，SSE 與 REST 共用。
 *
 * `sourceIds: null` 是「交給伺服器挑預設來源」，不帶這個參數；空陣列則是
 * 規劃不出任何來源，回 null 讓呼叫端當成錯誤 —— 送出去會被伺服器誤當成
 * 前者，整批改用預設來源重查一次。
 */
function buildBatchParams(
  keyword: string,
  batch: MangaSearchBatch
): URLSearchParams | null {
  const sourceIds = batch.sourceIds;
  if (sourceIds?.length === 0) return null;
  const params = new URLSearchParams({ q: keyword });
  if (sourceIds) params.set('sourceIds', sourceIds.join(','));
  return params;
}

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
      {withButton && (
        <div className='h-9 w-full animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800' />
      )}
    </div>
  );
}

export default function MangaSearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q')?.trim() || '';
  const urlSourceId =
    searchParams.get('sourceIds') || searchParams.get('sourceId') || '';
  const urlCreator = searchParams.get('creator')?.trim() || '';
  const rawCreatorRole = searchParams.get('creatorRole');
  const urlCreatorRole: MangaCreatorRole | undefined =
    rawCreatorRole === 'author' || rawCreatorRole === 'artist'
      ? rawCreatorRole
      : undefined;

  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<MangaSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [results, setResults] = useState<MangaSearchItem[]>([]);
  const [shelf, setShelf] = useState<Record<string, MangaShelfItem>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const restoredRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  /**
   * 讓「停止」能立刻解掉正在 await 的那一批（SSE 與非流式共用）。
   *
   * 不能只靠 `EventSource.close()` 觸發 onerror —— 規範上 close() 不派送
   * 任何事件，那條路徑上批次迴圈會永遠停在 await，後續批次雖然不會發出，
   * 但整個搜尋流程也永遠收不了尾。
   */
  const abortBatchRef = useRef<(() => void) | null>(null);
  /**
   * 批次規劃需要的來源清單／探測結果／上限。
   *
   * 刻意放在 ref 而不是讓 performSearch 依賴同名 state：來源 API 會更新
   * setSources，搜尋收尾會更新 setSourceHealth；任一變成 callback dependency
   * 都會讓 URL effect 對同一組條件重新搜尋。
   */
  const searchPlanRef = useRef<{
    sources: MangaSource[];
    probe: Record<string, MangaSourceProbeSummary>;
    maxSources?: number;
  }>({ sources: [], probe: {} });
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
  /** 使用者按了停止：不是錯誤，畫面要留著已完成的部分結果 */
  const [stopped, setStopped] = useState(false);
  const [sourceHealth, setSourceHealth] = useState<
    Record<string, MangaSourceHealth>
  >({});
  const [sourceProbe, setSourceProbe] = useState<
    Record<string, MangaSourceProbeSummary>
  >({});
  const pendingHealthRef = useRef<MangaSourceHealthEntry[]>([]);
  const [maxSources, setMaxSources] = useState<number | undefined>(undefined);
  const [failedSources, setFailedSources] = useState<MangaSearchFailure[]>([]);
  /**
   * 來源清單是否已經取回（成功或失敗都算）。
   *
   * URL 帶著 q 進站時要等這一步才開始搜尋：有授權後的來源清單與 probe
   * 才能排序；清單不可用時，performSearch 再依是否明確選源安全退回。
   */
  const [sourcesReady, setSourcesReady] = useState(false);
  /** 空陣列 = 不篩選（顯示全部來源的結果） */
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<MangaResultSort>('chapters');
  const [groupBySource, setGroupBySource] = useState(false);
  const [showFailedDetail, setShowFailedDetail] = useState(false);
  /** 實際 render 的卡片數上限；資料 state 仍保留全部結果 */
  const [renderLimit, setRenderLimit] = useState(MANGA_RESULT_RENDER_PAGE_SIZE);
  const {
    observe: observeChapterSummary,
    reset: resetChapterSummaryQueue,
  } = useMangaChapterSummaryQueue({
    onSummaries: (summaries) => {
      setResults((prev) =>
        prev.map((item) => {
          const summary = summaries[`${item.sourceId}+${item.id}`];
          return summary
            ? {
                ...item,
                latestChapterCount: summary.count,
                latestChapterName: summary.latestName,
              }
            : item;
        })
      );
    },
  });

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
   * 所以只保留「關鍵字與來源選擇」這類非授權的 UI 狀態。搜尋結果一律由
   * 授權後的 API 取得，SSE 再逐批、逐來源回傳。
   */
  const saveSearchState = useCallback(
    (nextState: { query: string; sourceId: string }) => {
      if (typeof window === 'undefined') return;
      try {
        sessionStorage.setItem(
          MANGA_SEARCH_STATE_KEY,
          JSON.stringify({
            query: nextState.query,
            sourceId: nextState.sourceId,
          })
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
      const parsed = JSON.parse(cached) as {
        query?: string;
        sourceId?: string;
      };
      return { query: parsed.query || '', sourceId: parsed.sourceId || '' };
    } catch {
      return null;
    }
  }, []);

  const readFluidSearchSetting = useCallback(() => {
    if (typeof window === 'undefined') return true;
    try {
      const savedFluidSearch = localStorage.getItem('fluidSearch');
      if (savedFluidSearch !== null)
        return JSON.parse(savedFluidSearch) !== false;
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

  /** 立刻清空 buffer；一般更新用 transition，停止操作則同步顯示已取得的結果 */
  const flushPendingResults = useCallback((urgent = false) => {
    const toAppend = pendingResultsRef.current;
    pendingResultsRef.current = [];
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (toAppend.length === 0) return;
    const append = () => setResults((prev) => prev.concat(toAppend));
    if (urgent) {
      append();
    } else {
      startTransition(append);
    }
  }, []);

  const appendBufferedResults = useCallback(
    (nextResults: MangaSearchItem[]) => {
      if (nextResults.length === 0) return;
      pendingResultsRef.current.push(...nextResults);
      if (!flushTimerRef.current) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          flushPendingResults();
        }, 80);
      }
    },
    [flushPendingResults]
  );

  /**
   * 同步取走並落盤已完成來源的速度量測。cleanup 只需持久化，不應再 setState；
   * 一般收尾再用 flushPendingHealth 同步畫面的狀態標記。
   */
  const persistPendingHealth = useCallback(() => {
    const measured = pendingHealthRef.current;
    pendingHealthRef.current = [];
    return measured.length > 0 ? recordMangaSourceHealth(measured) : null;
  }, []);

  const flushPendingHealth = useCallback(() => {
    const next = persistPendingHealth();
    if (next) setSourceHealth(next);
  }, [persistPendingHealth]);

  /**
   * 作廢目前這一輪搜尋。
   *
   * generation 遞增讓晚到的 SSE message 與 fetch resolve 全部失效，也讓
   * 批次迴圈在下一個檢查點退出 —— 尚未開始的批次因此完全不會發出請求。
   * 遞增必須排在中止之前：反過來的話舊流的中斷會被當成「這一次」的連線失敗。
   *
   * 最後一步是主動解掉停在 await 的那一批：`EventSource.close()` 規範上
   * 不派送任何事件，光關連線那個 promise 永遠不會 resolve。
   */
  const cancelActiveSearch = useCallback(() => {
    searchGenerationRef.current += 1;
    closeEventSource();
    const abortBatch = abortBatchRef.current;
    abortBatchRef.current = null;
    abortBatch?.();
  }, [closeEventSource]);

  /**
   * 使用者按下停止。
   *
   * 已經回來的結果與量測都留著：停止是「不要再等了」，不是「取消這次搜尋」。
   */
  const stopSearch = useCallback(() => {
    if (!loading) return;
    cancelActiveSearch();
    flushPendingResults(true);
    flushPendingHealth();
    setLoading(false);
    setStopped(true);
  }, [cancelActiveSearch, flushPendingHealth, flushPendingResults, loading]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(
      () => controller.abort(),
      MANGA_SOURCE_PLAN_TIMEOUT_MS
    );

    fetch('/api/manga/sources', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('无法载入来源清单');
        return res.json();
      })
      .then((data) => {
        const nextSources: MangaSource[] = Array.isArray(data.sources)
          ? data.sources
          : [];
        const nextProbe: Record<string, MangaSourceProbeSummary> =
          data.probe || {};
        const nextMaxSources =
          typeof data.maxSources === 'number' && data.maxSources > 0
            ? data.maxSources
            : undefined;
        searchPlanRef.current = {
          sources: nextSources,
          probe: nextProbe,
          maxSources: nextMaxSources,
        };
        setSources(nextSources);
        setSourceProbe(nextProbe);
        if (nextMaxSources) setMaxSources(nextMaxSources);
      })
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(timeout);
        if (!disposed) setSourcesReady(true);
      });

    getAllMangaShelf()
      .then(setShelf)
      .catch(() => undefined);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
      persistPendingHealth();
      cancelActiveSearch();
      clearPendingResults();
    };
  }, [cancelActiveSearch, clearPendingResults, persistPendingHealth]);

  /**
   * 跑一批 SSE 搜尋。
   *
   * payload 裡的 completedSources／totalSources 都是**批內**計數，絕不能
   * 直接寫進全域 state —— 那會讓「搜索中 7/12」在每批開頭歸零成 0/5。
   * 全域進度一律用累加。
   */
  const runFluidBatch = useCallback(
    (keyword: string, batch: MangaSearchBatch, generation: number) =>
      new Promise<MangaSearchBatchOutcome>((resolve) => {
        const params = buildBatchParams(keyword, batch);
        if (!params) {
          resolve({ kind: 'error', message: '没有可用的搜索来源' });
          return;
        }
        const trackTotalFromResponse = batch.total === 'server';
        let settled = false;
        let batchFailures = 0;
        let firstFailure: MangaSearchFailure | undefined;
        const finish = (outcome: MangaSearchBatchOutcome) => {
          if (settled) return;
          settled = true;
          // 只清掉自己掛上的 hook：晚到的 onerror 不可把新一批的停止鉤子抹掉
          if (abortBatchRef.current === abortHook) abortBatchRef.current = null;
          closeEventSource();
          resolve(outcome);
        };
        const abortHook = () => finish({ kind: 'aborted' });
        abortBatchRef.current = abortHook;

        const es = new EventSource(`/api/manga/search/ws?${params.toString()}`);
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          if (!event.data) return;
          if (searchGenerationRef.current !== generation) {
            finish({ kind: 'aborted' });
            return;
          }
          try {
            const payload = JSON.parse(event.data);
            switch (payload.type) {
              case 'start':
                // 只有「規劃不出批次」時才靠串流回報總數，否則分母是計畫值
                if (trackTotalFromResponse) {
                  setTotalSources((prev) => prev + (payload.totalSources || 0));
                }
                break;
              case 'source_result':
                setCompletedSources((prev) => prev + 1);
                pendingHealthRef.current.push({
                  sourceId: String(payload.sourceId || ''),
                  elapsedMs:
                    typeof payload.elapsedMs === 'number'
                      ? payload.elapsedMs
                      : undefined,
                  failed: false,
                });
                if (
                  Array.isArray(payload.results) &&
                  payload.results.length > 0
                ) {
                  appendBufferedResults(payload.results as MangaSearchItem[]);
                }
                break;
              case 'source_error': {
                setCompletedSources((prev) => prev + 1);
                batchFailures += 1;
                pendingHealthRef.current.push({
                  sourceId: String(payload.sourceId || ''),
                  failed: true,
                  timedOut: payload.timedOut === true,
                });
                const failure = normalizeFailure(payload);
                if (!firstFailure) firstFailure = failure;
                // 單顆來源失敗只累積，後續批次照發
                setFailedSources((prev) => [...prev, failure]);
                break;
              }
              case 'error':
                finish({ kind: 'error', message: payload.error || '搜索失败' });
                break;
              case 'complete': {
                const failedCount = Array.isArray(payload.failedSources)
                  ? payload.failedSources.length
                  : batchFailures;
                const reportedAttempted =
                  typeof payload.totalSources === 'number'
                    ? payload.totalSources
                    : batch.sourceIds?.length || 0;
                const attempted = Math.max(reportedAttempted, failedCount);
                finish({
                  kind: 'complete',
                  attempted,
                  failedCount,
                  firstFailure,
                });
                break;
              }
            }
          } catch {
            // ignore malformed SSE payloads
          }
        };

        es.onerror = () => {
          if (settled) return;
          if (searchGenerationRef.current !== generation) {
            finish({ kind: 'aborted' });
            return;
          }
          // 連線層失敗（401、代理中斷、串流提前結束）不可偽裝成「沒有結果」
          finish({
            kind: 'error',
            message: '搜索连接中断，结果可能不完整，请重试',
          });
        };
      }),
    [appendBufferedResults, closeEventSource]
  );

  /** 非流式路徑的一批；用 AbortController 讓停止與新搜尋能真的掐掉請求 */
  const runRestBatch = useCallback(
    async (
      keyword: string,
      batch: MangaSearchBatch,
      generation: number
    ): Promise<MangaSearchBatchOutcome> => {
      const params = buildBatchParams(keyword, batch);
      if (!params) {
        return { kind: 'error', message: '没有可用的搜索来源' };
      }
      const trackTotalFromResponse = batch.total === 'server';
      const controller = new AbortController();
      const abortHook = () => controller.abort();
      abortBatchRef.current = abortHook;

      try {
        const res = await fetch(`/api/manga/search?${params.toString()}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (searchGenerationRef.current !== generation)
          return { kind: 'aborted' };
        if (!res.ok) throw new Error(data.error || '搜索失败');

        // 失敗來源要留給畫面，兩條路徑的可見度要一致
        const failures: MangaSearchFailure[] = Array.isArray(data.failedSources)
          ? (data.failedSources as MangaSearchFailure[]).map(normalizeFailure)
          : [];
        const reportedAttempted =
          typeof data.attemptedSources === 'number'
            ? data.attemptedSources
            : batch.sourceIds?.length || 1;
        const attempted = Math.max(reportedAttempted, failures.length);

        if (trackTotalFromResponse) setTotalSources((prev) => prev + attempted);
        setCompletedSources((prev) => prev + attempted);
        if (failures.length > 0) {
          setFailedSources((prev) => prev.concat(failures));
        }
        // 非流式路徑同樣要累積來源健康度，否則關閉流式搜尋後速度標記永遠不更新
        if (Array.isArray(data.measurements) && data.measurements.length > 0) {
          pendingHealthRef.current.push(...data.measurements);
        }
        // 逐批 append（不是覆蓋）：前面批次的結果要留在畫面上
        if (Array.isArray(data.results) && data.results.length > 0) {
          appendBufferedResults(data.results as MangaSearchItem[]);
        }
        return {
          kind: 'complete',
          attempted,
          failedCount: failures.length,
          firstFailure: failures[0],
        };
      } catch (err) {
        if (
          controller.signal.aborted ||
          searchGenerationRef.current !== generation
        ) {
          return { kind: 'aborted' };
        }
        return { kind: 'error', message: (err as Error).message || '搜索失败' };
      } finally {
        // 只清掉自己掛上的 hook（見 runFluidBatch 的同一條理由）
        if (abortBatchRef.current === abortHook) abortBatchRef.current = null;
      }
    },
    [appendBufferedResults]
  );

  const performSearch = useCallback(
    async (keyword: string, selectedSourceId: string) => {
      const trimmedQuery = keyword.trim();
      if (!trimmedQuery) return;
      const normalizedSourceId = selectedSourceId || '';

      // 新搜尋不重播舊結果，但上一輪已完成來源的速度量測仍然有效；先同步
      // 落盤，再關 transport，緊接著的排序即可使用這批最新資料。
      flushPendingHealth();
      cancelActiveSearch();
      clearPendingResults();
      const generation = searchGenerationRef.current;

      setLoading(true);
      setStopped(false);
      setError('');
      setHasSearched(true);
      setTotalSources(0);
      setCompletedSources(0);
      setFailedSources([]);
      setShowFailedDetail(false);
      // 分段展開的位置跟著這次搜尋重來
      setRenderLimit(MANGA_RESULT_RENDER_PAGE_SIZE);
      /*
       * 來源篩選也要清：上一次搜尋選的來源在這次可能根本沒有結果，
       * 留著會讓畫面看起來「什麼都沒搜到」。排序與分組是使用者的顯示
       * 偏好，跨搜尋保留。
       */
      setSourceFilter([]);

      // 結果一律重新向伺服器取得。不從本地快取先畫 ——
      // 那會讓剛被停用的來源內容短暫顯示出來，等同繞過授權。
      resetChapterSummaryQueue();
      setResults([]);

      const currentFluidSearch = readFluidSearchSetting();

      const plan = searchPlanRef.current;
      /*
       * 排序要用「這一刻」的本機量測，而不是讓 performSearch 依賴
       * sourceHealth state：收尾時落盤會重建 callback，而 URL effect 依賴
       * performSearch —— 同一組條件就會被無限重搜。
       *
       * sources 只是預設語言清單，不是完整授權集合；明確指定的跨語言來源
       * 必須保留，再由每一批的伺服器請求做最終授權。
       */
      const batches = planMangaSearchBatches({
        requestedSourceIds: normalizedSourceId.split(','),
        defaultSourceIds: plan.sources.map((source) => source.id),
        maxSources: plan.maxSources,
        hints: {
          probe: plan.probe,
          health: readMangaSourceHealth(),
        },
      });

      const plannedTotal = batches.reduce(
        (sum, batch) =>
          sum + (batch.total === 'planned' ? batch.sourceIds?.length ?? 0 : 0),
        0
      );
      if (plannedTotal > 0) setTotalSources(plannedTotal);

      const runBatch = currentFluidSearch ? runFluidBatch : runRestBatch;

      let attempted = 0;
      let failedCount = 0;
      let firstFailure: MangaSearchFailure | undefined;

      for (const batch of batches) {
        // 序列批次的重點就在這個 await：上一批收尾前不發下一批
        const outcome = await runBatch(trimmedQuery, batch, generation);

        // 停止或新搜尋：畫面狀態已由 stopSearch／新一輪接手，這裡什麼都不碰
        if (
          outcome.kind === 'aborted' ||
          searchGenerationRef.current !== generation
        ) {
          return;
        }
        if (outcome.kind === 'error') {
          // transport 或伺服器層錯誤會中止後續批次，但保留已回來的部分結果
          flushPendingResults(true);
          flushPendingHealth();
          setError(outcome.message);
          setLoading(false);
          return;
        }
        attempted += outcome.attempted;
        failedCount += outcome.failedCount;
        if (!firstFailure) firstFailure = outcome.firstFailure;
      }

      if (searchGenerationRef.current !== generation) return;

      flushPendingResults(true);
      flushPendingHealth();
      /*
       * 全滅要跨所有批次判斷。只看最後一批的話，前面全掛、最後一批成功會
       * 被講成「沒有找到」，而真正的全滅也可能因為最後一批是 0 顆而漏報。
       */
      if (isAllMangaSourcesFailed(attempted, failedCount)) {
        setError(
          firstFailure
            ? `所有来源都失败了，例如「${
                firstFailure.sourceName
              }」：${firstFailure.error.slice(0, 120)}`
            : '所有来源都搜索失败'
        );
      } else {
        /*
         * 只記關鍵字與來源選擇（非授權內容），供返回時還原輸入。
         * 全滅時不記：否則返回時會還原成一個看起來正常的空搜尋。
         */
        saveSearchState({ query: trimmedQuery, sourceId: normalizedSourceId });
      }
      // 伺服器可能因政策砍掉幾顆，分母對齊實際查過的數量
      if (attempted > 0) {
        setTotalSources((prev) => Math.min(prev, attempted));
        setCompletedSources(attempted);
      }
      setLoading(false);
    },
    [
      cancelActiveSearch,
      clearPendingResults,
      flushPendingHealth,
      flushPendingResults,
      readFluidSearchSetting,
      resetChapterSummaryQueue,
      runFluidBatch,
      runRestBatch,
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

    if (!urlQuery) {
      setQuery('');
      setSourceId('');
      cancelActiveSearch();
      clearPendingResults();
      resetChapterSummaryQueue();
      setResults([]);
      setLoading(false);
      setStopped(false);
      setHasSearched(false);
      setTotalSources(0);
      setCompletedSources(0);
      setError('');
      setFailedSources([]);
      setShowFailedDetail(false);
      setSourceFilter([]);
      return;
    }

    setQuery(urlQuery);
    setSourceId(urlSourceId);
  }, [
    cancelActiveSearch,
    clearPendingResults,
    resetChapterSummaryQueue,
    restoreSearchState,
    urlQuery,
    urlSourceId,
  ]);

  useEffect(() => {
    if (!urlQuery || !sourcesReady) return;
    void performSearch(urlQuery, urlSourceId);
  }, [performSearch, sourcesReady, urlQuery, urlSourceId]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    const params = new URLSearchParams({ q: trimmedQuery });
    if (sourceId) params.set('sourceId', sourceId);
    const nextUrl = `/manga/search?${params.toString()}`;
    if (urlQuery === trimmedQuery && urlSourceId === sourceId && !urlCreator) {
      // metadata 尚未 ready 時 URL effect 會在收尾後啟動；這裡先發會造成重複搜尋，
      // 也會讓使用者剛按下的「停止搜索」被 readiness effect 撤銷。
      if (!sourcesReady) return;
      await performSearch(trimmedQuery, sourceId);
    } else {
      // 一般搜尋刻意不帶 creator：使用者手動改關鍵字／來源就代表離開作者篩選
      router.replace(nextUrl);
    }
  };

  /* returnTo 完全由目前 URL 組成，不混入上一代 lastSearched state。 */
  const returnTo = useMemo(() => {
    const params = new URLSearchParams();
    if (urlQuery) params.set('q', urlQuery);
    if (urlSourceId) params.set('sourceId', urlSourceId);
    if (urlCreator) params.set('creator', urlCreator);
    if (urlCreatorRole) params.set('creatorRole', urlCreatorRole);
    const queryString = params.toString();
    return queryString ? `/manga/search?${queryString}` : '/manga/search';
  }, [urlQuery, urlSourceId, urlCreator, urlCreatorRole]);

  /**
   * creator filter 完全由 URL 推導，不再維護第二份 state。
   * 點作者時 URL 一定只帶單一 sourceId；手動竄改成多來源則不套 creator
   * exact filter，避免一個來源的作者名誤套到另一顆來源。
   */
  const creatorFilter = useMemo<MangaCreatorFilter | null>(() => {
    const ids = urlSourceId
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (!urlCreator || ids.length !== 1) return null;
    return {
      sourceId: ids[0],
      name: urlCreator,
      role: urlCreatorRole,
    };
  }, [urlCreator, urlCreatorRole, urlSourceId]);

  const creatorRoleLabel = creatorFilter
    ? creatorFilter.role === 'artist'
      ? '绘师'
      : creatorFilter.role === 'author'
      ? '作者'
      : '作者／绘师'
    : '';

  /** 篩選橫幅上的來源名稱：管理員設定的 displayName 優先，其次原始名稱 */
  const creatorSource = creatorFilter
    ? sources.find((source) => source.id === creatorFilter.sourceId)
    : undefined;

  const sourceBuckets = useMemo(
    () => buildSourceBuckets(results, { streaming: loading }),
    [results, loading]
  );

  const visibleResults = useMemo(
    () =>
      selectVisibleResults(results, {
        sourceFilter,
        sortMode,
        creatorFilter,
      }),
    [results, sourceFilter, sortMode, creatorFilter]
  );

  const groupedSourceBuckets = useMemo(
    () => buildSourceBuckets(visibleResults, { streaming: loading }),
    [visibleResults, loading]
  );

  /*
   * 只 render 前 renderLimit 筆（理由見 MANGA_RESULT_RENDER_PAGE_SIZE）；
   * 資料 state 保留全部結果，篩選 chip 的計數與來源分桶都要用完整資料。
   */
  const renderedResults = useMemo(
    () => visibleResults.slice(0, renderLimit),
    [visibleResults, renderLimit]
  );

  const hiddenResultCount = visibleResults.length - renderedResults.length;

  /**
   * 換來源／作者篩選後要從新篩選的前 96 筆重新看，否則使用者在 A 來源展開
   * 到 288 筆、切到只有 12 筆的 B 來源，limit 仍留在 288 —— 下一次切回
   * 全部又直接畫 288 張卡。排序與分組是純顯示切換，不重設。
   */
  useEffect(() => {
    setRenderLimit(MANGA_RESULT_RENDER_PAGE_SIZE);
  }, [sourceFilter, creatorFilter]);

  const groupedResults = useMemo(
    () =>
      groupBySource
        ? groupResultsBySource(renderedResults, groupedSourceBuckets, {
            sortMode,
          })
        : [],
    [groupBySource, groupedSourceBuckets, renderedResults, sortMode]
  );

  /** 點作者／绘师：限定同一來源重新搜尋，再由 creatorFilter exact 收斂 */
  const searchCreator = (
    item: MangaSearchItem,
    creator: string,
    role: MangaCreatorRole
  ) => {
    const params = new URLSearchParams({
      q: creator,
      sourceId: item.sourceId,
      creator,
      creatorRole: role,
    });
    // 這是從目前結果集鑽進作者／绘师作品，不是「改寫目前搜尋」；push 才讓
    // 瀏覽器上一頁能回到原關鍵字。用 replace 會讓誤觸一顆密集排列的 chip
    // 後，原本數百筆結果的 URL 從 history 消失。
    router.push(`/manga/search?${params.toString()}`);
  };

  /** 只解除 exact filter；保留作者名搜尋結果，讓使用者看來源的模糊匹配內容 */
  const clearCreatorFilter = () => {
    const params = new URLSearchParams();
    if (urlQuery) params.set('q', urlQuery);
    if (urlSourceId) params.set('sourceId', urlSourceId);
    router.replace(`/manga/search?${params.toString()}`);
  };

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

  /** 分組模式與平鋪模式共用同一份卡片渲染，避免兩邊各改一次而長歪 */
  const renderResultCard = (item: MangaSearchItem) => {
    const key = `${item.sourceId}+${item.id}`;
    const creatorGroups = getMangaCreatorGroups(item);
    const sourceStatus = formatMangaSearchStatus(
      sourceProbe[item.sourceId],
      sourceHealth[item.sourceId]
    );
    return (
      <div
        key={key}
        ref={(element) => observeChapterSummary(element, item)}
        className='space-y-2'
      >
        <MangaCard
          item={item}
          href={`/manga/detail?mangaId=${item.id}&sourceId=${
            item.sourceId
          }&title=${encodeURIComponent(item.title)}&cover=${encodeURIComponent(
            item.cover
          )}&sourceName=${encodeURIComponent(
            item.sourceName
          )}&description=${encodeURIComponent(
            item.description || ''
          )}&author=${encodeURIComponent(
            item.author || ''
          )}&status=${encodeURIComponent(
            item.status || ''
          )}&returnTo=${encodeURIComponent(returnTo)}`}
          subtitle={[
            item.sourceName,
            item.latestChapterName
              ? `最新 ${item.latestChapterName}`
              : item.latestChapterCount
                ? `共 ${item.latestChapterCount} 话`
                : undefined,
            sourceStatus?.label,
            item.author || item.status || item.description,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        {creatorGroups.map((group) => (
          <div key={group.role} className='flex flex-wrap items-center gap-1.5'>
            <span className='text-[11px] text-gray-500 dark:text-gray-400'>
              {group.label}
            </span>
            {group.creators.map((creator) => (
              <button
                key={creator.toLowerCase()}
                type='button'
                onClick={() => searchCreator(item, creator, group.role)}
                title={`搜索 ${creator} 在 ${item.sourceName} 的全部${group.label}作品`}
                className='min-h-8 max-w-full truncate rounded-full border border-gray-200 px-2.5 text-[11px] text-sky-700 transition-colors hover:border-sky-500 hover:bg-sky-50 dark:border-gray-700 dark:text-sky-300 dark:hover:border-sky-500 dark:hover:bg-sky-950/40'
              >
                {creator}
              </button>
            ))}
          </div>
        ))}
        <button
          type='button'
          onClick={() => toggleShelf(item)}
          className='w-full rounded-2xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-sky-500 hover:text-sky-600 dark:border-gray-700 dark:text-gray-200'
        >
          {shelf[key] ? '移出书架' : '加入书架'}
        </button>
      </div>
    );
  };

  return (
    <div className='mx-auto max-w-6xl'>
      <form className='mx-auto mb-8 max-w-4xl' onSubmit={handleSearch}>
        <div className='flex flex-col gap-3 lg:flex-row'>
          <div className='flex-1'>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='搜索漫画标题、作者或绘师'
              className='w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none transition focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900'
            />
          </div>
          <MangaSourceMultiPicker
            sources={sources}
            value={sourceId ? sourceId.split(',').filter(Boolean) : []}
            onChange={(ids) => setSourceId(ids.join(','))}
            health={sourceHealth}
            probe={sourceProbe}
            maxActive={maxSources}
            className='lg:w-64'
          />
          <button className='inline-flex items-center justify-center gap-2 rounded-2xl bg-sky-600 px-6 py-3 text-sm font-medium text-white transition hover:bg-sky-700 lg:w-32'>
            <Search className='h-4 w-4' /> 搜索
          </button>
        </div>
      </form>

      <section>
        <div className='mb-3 flex flex-wrap items-center justify-between gap-3'>
          <h2 className='text-lg font-semibold'>
            搜索结果
            {results.length > 0
              ? visibleResults.length === results.length
                ? `（${results.length}）`
                : `（${visibleResults.length} / ${results.length}）`
              : ''}
          </h2>
          <div className='flex flex-wrap items-center gap-2 text-xs'>
            {loading && totalSources > 0 && (
              <span className='text-gray-500 dark:text-gray-400'>
                搜索中 {completedSources}/{totalSources}
              </span>
            )}
            {loading && (
              <button
                type='button'
                onClick={stopSearch}
                className='min-h-9 rounded-xl border border-gray-200 px-3 text-gray-600 transition-colors hover:border-red-400 hover:text-red-500 dark:border-gray-700 dark:text-gray-300'
              >
                停止搜索
              </button>
            )}
            {/* 停止不是錯誤，所以用中性色講清楚「停在哪」，不走紅色錯誤區 */}
            {!loading && stopped && (
              <span className='text-amber-600 dark:text-amber-400'>
                已停止搜索
                {totalSources > 0
                  ? `（${completedSources}/${totalSources}）`
                  : ''}
              </span>
            )}
            {results.length > 0 && (
              <>
                <label className='flex items-center gap-1 text-gray-500 dark:text-gray-400'>
                  排序
                  <select
                    value={sortMode}
                    onChange={(event) =>
                      setSortMode(event.target.value as MangaResultSort)
                    }
                    className='min-h-9 cursor-pointer rounded-xl border border-gray-200 bg-gray-50 px-2 text-xs text-gray-900 outline-none transition focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
                  >
                    <option value='chapters'>话数</option>
                    <option value='arrival'>來源回應順序</option>
                    <option value='source'>來源名稱</option>
                    <option value='title'>標題</option>
                  </select>
                </label>
                <button
                  type='button'
                  onClick={() => setGroupBySource((prev) => !prev)}
                  className={`min-h-9 rounded-xl border px-3 transition-colors ${
                    groupBySource
                      ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                      : 'border-gray-200 text-gray-600 hover:border-sky-500 dark:border-gray-700 dark:text-gray-300'
                  }`}
                >
                  {groupBySource ? '依來源分組：開' : '依來源分組：關'}
                </button>
              </>
            )}
          </div>
        </div>

        {creatorFilter && (
          <div className='mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-sky-50 px-4 py-3 text-xs text-sky-800 dark:bg-sky-950/30 dark:text-sky-200'>
            <span>
              {creatorRoleLabel}：<strong>{creatorFilter.name}</strong>
            </span>
            <span className='text-sky-600/70 dark:text-sky-300/70'>
              {creatorSource?.displayName ||
                creatorSource?.name ||
                creatorFilter.sourceId}
            </span>
            <button
              type='button'
              onClick={clearCreatorFilter}
              className='min-h-8 rounded-full border border-sky-300 px-3 font-medium transition-colors hover:border-sky-500 hover:bg-white/70 dark:border-sky-700 dark:hover:border-sky-500 dark:hover:bg-sky-950/50'
            >
              清除{creatorRoleLabel}筛选
            </button>
          </div>
        )}

        {/* 來源篩選：放寬上限後結果會來自數十顆來源，而 grid 是按到達順序排的，
            最快的兩三顆會霸佔前排。沒有這排 chip 使用者滾不到其他來源。 */}
        {sourceBuckets.length > 1 && (
          <div className='mb-3 flex flex-wrap items-center gap-2'>
            <button
              type='button'
              onClick={() => setSourceFilter([])}
              className={`min-h-9 rounded-full border px-3 text-xs transition-colors ${
                sourceFilter.length === 0
                  ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                  : 'border-gray-200 text-gray-600 hover:border-sky-500 dark:border-gray-700 dark:text-gray-300'
              }`}
            >
              全部（{results.length}）
            </button>
            {sourceBuckets.map((bucket) => {
              const active = sourceFilter.includes(bucket.sourceId);
              return (
                <button
                  key={bucket.sourceId}
                  type='button'
                  onClick={() =>
                    setSourceFilter((prev) =>
                      prev.includes(bucket.sourceId)
                        ? prev.filter((id) => id !== bucket.sourceId)
                        : [...prev, bucket.sourceId]
                    )
                  }
                  className={`min-h-9 rounded-full border px-3 text-xs transition-colors ${
                    active
                      ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                      : 'border-gray-200 text-gray-600 hover:border-sky-500 dark:border-gray-700 dark:text-gray-300'
                  }`}
                >
                  {bucket.sourceName}（{bucket.count}）
                </button>
              );
            })}
          </div>
        )}

        {error && <div className='mb-4 text-sm text-red-500'>{error}</div>}

        {/* 失敗來源要可見：放寬上限後實測 51 顆裡有 8 顆搜尋失敗、2 顆超過
            per-source deadline。不顯示的話使用者會把「這幾顆沒回來」誤讀成
            「這些來源沒有這部作品」。 */}
        {failedSources.length > 0 && (
          <div className='mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'>
            <button
              type='button'
              onClick={() => setShowFailedDetail((prev) => !prev)}
              className='font-medium underline-offset-2 hover:underline'
            >
              {failedSources.length} 个来源没有回应
              {failedSources.some((f) => f.timedOut)
                ? `（含 ${
                    failedSources.filter((f) => f.timedOut).length
                  } 个超时）`
                : ''}
              ，{showFailedDetail ? '收起' : '展开'}
            </button>
            {showFailedDetail && (
              <ul className='mt-2 space-y-1'>
                {failedSources.map((failed) => (
                  <li key={failed.sourceId}>
                    <span className='font-medium'>{failed.sourceName}</span>
                    {failed.timedOut ? '（超时）' : ''}：{failed.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {loading && results.length === 0 ? (
          <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
            {Array.from({ length: 12 }).map((_, index) => (
              <MangaCardSkeleton key={index} withButton />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className='rounded-2xl bg-gray-50 p-10 text-center text-sm text-gray-500 dark:bg-gray-900/50'>
            {/* 停在還沒有任何結果的時候：不能講成「没有找到」，那是不同的事 */}
            {stopped
              ? '已停止搜索，还没有取得结果'
              : hasSearched
              ? '没有找到相关漫画'
              : '请输入关键词开始搜索漫画'}
          </div>
        ) : visibleResults.length === 0 ? (
          <div className='rounded-2xl bg-gray-50 p-10 text-center text-sm text-gray-500 dark:bg-gray-900/50'>
            {creatorFilter
              ? `没有找到「${creatorFilter.name}」的作品，可清除${creatorRoleLabel}筛选查看来源的模糊匹配结果`
              : '目前的来源筛选没有结果，换一个来源或点「全部」'}
          </div>
        ) : groupBySource ? (
          <div className='space-y-6'>
            {groupedResults.map((group) => (
              <div key={group.sourceId} className='space-y-3'>
                <div className='flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200'>
                  {group.sourceName}
                  <span className='text-xs text-gray-500 dark:text-gray-400'>
                    {group.items.length === group.count
                      ? `${group.count} 部`
                      : `${group.items.length} / ${group.count} 部`}
                  </span>
                </div>
                <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
                  {group.items.map(renderResultCard)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
            {renderedResults.map(renderResultCard)}
          </div>
        )}

        {/* 分組與平鋪都吃同一個 render 窗口，所以展開按鈕放在兩者外面 */}
        {hiddenResultCount > 0 && (
          <div className='mt-6 flex justify-center'>
            <button
              type='button'
              onClick={() =>
                setRenderLimit((prev) => prev + MANGA_RESULT_RENDER_PAGE_SIZE)
              }
              className='min-h-10 rounded-2xl border border-gray-200 px-6 text-sm text-gray-600 transition-colors hover:border-sky-500 hover:text-sky-600 dark:border-gray-700 dark:text-gray-300'
            >
              显示更多（剩余 {hiddenResultCount}）
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
