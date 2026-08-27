'use client';

import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/** 單一能力（熱門／搜尋）的探測結果 */
export interface AdminMangaSourceProbeOutcome {
  ok: boolean;
  elapsedMs: number;
  count: number;
  error?: string;
}

export interface AdminMangaSourceProbe {
  sourceId: string;
  popular: AdminMangaSourceProbeOutcome;
  search: AdminMangaSourceProbeOutcome;
  testedAt: number;
}

export interface AdminMangaSource {
  id: string;
  name: string;
  displayName?: string;
  lang?: string;
  contentWarning?: 'SAFE' | 'MIXED' | 'NSFW';
  enabled: boolean;
  probe: AdminMangaSourceProbe | null;
}

/** 延遲分級：綠 <1.5s、琥珀 <5s、紅 >=5s */
function latencyTone(ms: number): 'good' | 'slow' | 'bad' {
  if (ms < 1500) return 'good';
  if (ms < 5000) return 'slow';
  return 'bad';
}

/**
 * 秒以下顯示 ms —— `(14/1000).toFixed(1)` 會變成「0.0s」，看起來像沒量到。
 */
function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 相對時間；用來表達「這份燈號有多舊」 */
export function formatRelativeTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return '剛剛';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 單一能力的狀態燈。
 *
 * 熱門與搜尋分開顯示，因為它們會各自壞掉：實測有來源熱門正常卻搜不到
 * （擴充套件沒實作搜尋），也有來源熱門逾時卻搜得到。合成一顆燈兩邊都會判錯。
 *
 * 刻意同時輸出標籤文字與圖示，不只用顏色 —— 色盲使用者無法只靠紅綠分辨，
 * WCAG 也要求不可僅以顏色傳達資訊。
 */
function CapabilityBadge({
  label,
  outcome,
}: {
  label: string;
  outcome: AdminMangaSourceProbeOutcome;
}) {
  if (!outcome.ok) {
    return (
      <span
        className='inline-flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-2 py-1 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-300'
        title={outcome.error || '請求失敗'}
      >
        <XCircle aria-hidden='true' className='h-3.5 w-3.5' />
        {label}
      </span>
    );
  }

  const tone = latencyTone(outcome.elapsedMs);
  const toneClass =
    tone === 'good'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
      : tone === 'slow'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs ${toneClass}`}
      title={`${label}：取得 ${outcome.count} 筆，耗時 ${outcome.elapsedMs}ms`}
    >
      <CheckCircle2 aria-hidden='true' className='h-3.5 w-3.5' />
      {label}
      <span className='font-medium tabular-nums'>
        {formatLatency(outcome.elapsedMs)}
      </span>
    </span>
  );
}

function SourceStatusBadge({ probe }: { probe: AdminMangaSourceProbe | null }) {
  if (!probe) {
    return (
      <span className='inline-flex shrink-0 items-center gap-1.5 rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400'>
        <span aria-hidden='true' className='h-2 w-2 rounded-full bg-gray-400' />
        未測試
      </span>
    );
  }

  return (
    <span
      className='inline-flex shrink-0 flex-wrap items-center justify-end gap-1'
      title={`測試於 ${new Date(probe.testedAt).toLocaleString('zh-TW')}`}
    >
      <CapabilityBadge label='熱門' outcome={probe.popular} />
      <CapabilityBadge label='搜尋' outcome={probe.search} />
    </span>
  );
}

interface MangaSourceManagerPanelProps {
  /** Suwayomi 未啟用時只顯示提示，不去打 API */
  suwayomiEnabled?: boolean;
}

/**
 * 漫畫源管理面板：開關、狀態燈號、延遲、手動重測。
 *
 * 自帶狀態與錯誤顯示，不依賴 admin 頁內部的 hooks，
 * 因此可同時嵌在 /admin 與 /manga 的管理員入口。
 */
export default function MangaSourceManagerPanel({
  suwayomiEnabled = true,
}: MangaSourceManagerPanelProps) {
  const [sources, setSources] = useState<AdminMangaSource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  /**
   * 依燈號篩選。
   *
   * `ok` / `failed` 的判斷用「熱門與搜尋是否都正常」與「任一失敗」——
   * 兩個能力分開顯示之後，「這顆是綠燈還是紅燈」不再是單一布林，
   * 篩選要明確定義才不會讓使用者以為漏掉東西。
   */
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'ok' | 'failed' | 'untested'
  >('all');
  /** 最近一次「全部測試」的時間；null = 從未測過 */
  const [probedAt, setProbedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<
    'test' | 'enable_all' | 'disable_all' | null
  >(null);
  /** 批量測試進度：已完成 / 總數 */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );

  const markBusy = (ids: string[], busy: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (busy ? next.add(id) : next.delete(id)));
      return next;
    });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/manga-sources');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '讀取失敗');
      setSources(data.sources || []);
      setProbedAt(typeof data.probedAt === 'number' ? data.probedAt : null);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (suwayomiEnabled) load();
  }, [load, suwayomiEnabled]);

  const call = async (payload: Record<string, unknown>) => {
    const res = await fetch('/api/admin/manga-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '操作失敗');
    return data;
  };

  const applyProbes = (results: AdminMangaSourceProbe[]) => {
    const byId = new Map(results.map((item) => [item.sourceId, item]));
    setSources((prev) =>
      prev.map((item) =>
        byId.has(item.id) ? { ...item, probe: byId.get(item.id)! } : item
      )
    );
  };

  const toggle = async (source: AdminMangaSource) => {
    const next = !source.enabled;
    markBusy([source.id], true);
    // 樂觀更新：切換是高頻操作，等往返會很鈍
    setSources((prev) =>
      prev.map((item) =>
        item.id === source.id ? { ...item, enabled: next } : item
      )
    );
    try {
      await call({
        action: next ? 'enable' : 'disable',
        sourceId: source.id,
      });
      setError('');
    } catch (err) {
      // 失敗回滾，避免畫面與後端不一致
      setSources((prev) =>
        prev.map((item) =>
          item.id === source.id ? { ...item, enabled: !next } : item
        )
      );
      setError(`切換「${source.name}」失敗：${(err as Error).message}`);
    } finally {
      markBusy([source.id], false);
    }
  };

  const bulkToggle = async (action: 'enable_all' | 'disable_all') => {
    setBulkBusy(action);
    try {
      await call({ action });
      await load();
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(null);
    }
  };

  /**
   * 測試指定來源；`ids` 省略代表全部。
   * 分批送出，讓進度可見也避免一次打爆上游。
   */
  const runTest = async (ids?: string[]) => {
    // 沒帶 ids = 使用者按了「測試全部」。這個區別要保留到最後一批，
    // 才能決定要不要更新「上次全部測試」的時間戳。
    const isFullRun = !ids || ids.length === 0;
    const targets = isFullRun ? sources.map((s) => s.id) : ids;
    if (targets.length === 0) return;

    const single = targets.length === 1;
    if (single) markBusy(targets, true);
    else {
      setBulkBusy('test');
      setProgress({ done: 0, total: targets.length });
    }

    try {
      const CHUNK = 8;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const chunk = targets.slice(i, i + CHUNK);
        const isLastChunk = i + CHUNK >= targets.length;
        markBusy(chunk, true);
        try {
          // fullRun 只在「測試全部」的最後一批送出。不能讓後端用
          // 「這批的數量等於全清單」推斷 —— 前端是分批送的，沒有任何一批
          // 會等於全清單，那樣時間戳永遠不會被寫入。
          const data = await call({
            action: 'test',
            sourceIds: chunk,
            ...(isFullRun && isLastChunk ? { fullRun: true } : {}),
          });
          applyProbes(data.results || []);
          if (typeof data.probedAt === 'number') setProbedAt(data.probedAt);
        } finally {
          markBusy(chunk, false);
          if (!single) {
            setProgress({
              done: Math.min(i + chunk.length, targets.length),
              total: targets.length,
            });
          }
        }
      }
      setError('');
    } catch (err) {
      setError(`測試失敗：${(err as Error).message}`);
    } finally {
      if (single) {
        markBusy(targets, false);
      } else {
        // 只有批量路徑設過這兩個狀態。單一測試若也清，會把同時進行的
        // 批量測試守衛清掉，讓「測試全部／全部啟用／全部停用」在批量途中
        // 變成可點，導致重複掃描與互斥寫入並發。
        setBulkBusy(null);
        setProgress(null);
      }
    }
  };

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return sources.filter((item) => {
      if (onlyEnabled && !item.enabled) return false;

      if (statusFilter !== 'all') {
        const probe = item.probe;
        if (statusFilter === 'untested') {
          if (probe) return false;
        } else if (!probe) {
          // 未測試的來源不屬於綠燈也不屬於紅燈
          return false;
        } else if (statusFilter === 'ok') {
          // 綠燈 = 兩個能力都正常。只有熱門正常的來源會搜不到，
          // 歸進綠燈會讓使用者以為它可用
          if (!probe.popular.ok || !probe.search.ok) return false;
        } else if (probe.popular.ok && probe.search.ok) {
          // statusFilter === 'failed'：任一能力失敗就算
          return false;
        }
      }

      if (!keyword) return true;
      return (
        item.name.toLowerCase().includes(keyword) ||
        (item.displayName || '').toLowerCase().includes(keyword) ||
        (item.lang || '').toLowerCase().includes(keyword)
      );
    });
  }, [onlyEnabled, query, sources, statusFilter]);

  const visibleIds = useMemo(() => visible.map((item) => item.id), [visible]);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleSelectAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });

  const enabledCount = sources.filter((item) => item.enabled).length;
  const testing = bulkBusy === 'test';
  /**
   * 任一測試／批量動作進行中。批量按鈕要連「單一列測試進行中」都禁用，
   * 否則單測途中可觸發批量掃描，兩者互斥寫入並發。
   */
  const anyBusy = bulkBusy !== null || busyIds.size > 0;

  if (!suwayomiEnabled) {
    return (
      <div className='rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-gray-800/60 dark:text-gray-400'>
        啟用 Suwayomi 並儲存設定後，這裡會列出所有漫畫源供開關與測試。
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h4 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            漫畫源管理
          </h4>
          <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
            已啟用 {enabledCount} / {sources.length} 個；停用的來源對一般使用者
            完全不可見（含詳情、章節與圖片）
          </p>
        </div>
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            onClick={() => runTest()}
            disabled={anyBusy || sources.length === 0}
            className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              anyBusy || sources.length === 0
                ? 'cursor-not-allowed bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                : 'cursor-pointer bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            <RefreshCw
              aria-hidden='true'
              className={`h-4 w-4 ${testing ? 'animate-spin' : ''}`}
            />
            {testing && progress
              ? `測試中 ${progress.done}/${progress.total}`
              : '測試全部'}
          </button>
          <button
            type='button'
            onClick={() => runTest(selectedVisible)}
            disabled={anyBusy || selectedVisible.length === 0}
            className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              anyBusy || selectedVisible.length === 0
                ? 'cursor-not-allowed bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                : 'cursor-pointer bg-sky-600 text-white hover:bg-sky-700'
            }`}
          >
            測試選取{selectedVisible.length > 0 ? ` (${selectedVisible.length})` : ''}
          </button>
          <button
            type='button'
            onClick={() => bulkToggle('enable_all')}
            disabled={anyBusy}
            className='min-h-11 cursor-pointer rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 transition-colors duration-200 hover:border-green-500 hover:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200'
          >
            全部啟用
          </button>
          <button
            type='button'
            onClick={() => bulkToggle('disable_all')}
            disabled={anyBusy}
            className='min-h-11 cursor-pointer rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 transition-colors duration-200 hover:border-red-500 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200'
          >
            全部停用
          </button>
        </div>
      </div>

      <div className='flex flex-wrap items-center gap-3'>
        <label className='sr-only' htmlFor='manga-source-filter'>
          搜尋漫畫源
        </label>
        <input
          id='manga-source-filter'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='搜尋名稱或語言'
          className='min-h-11 min-w-[12rem] flex-1 rounded-lg border border-gray-300 px-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
        />
        <label className='inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300'>
          <input
            type='checkbox'
            checked={onlyEnabled}
            onChange={(e) => setOnlyEnabled(e.target.checked)}
            className='h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/40'
          />
          只看已啟用
        </label>
        <button
          type='button'
          onClick={toggleSelectAll}
          disabled={visibleIds.length === 0}
          className='min-h-11 cursor-pointer rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 transition-colors duration-200 hover:border-blue-500 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200'
        >
          {allVisibleSelected ? '取消全選' : '全選當前列表'}
        </button>
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-xs text-gray-500 dark:text-gray-400'>燈號</span>
        {(
          [
            ['all', '全部'],
            ['ok', '綠燈（熱門與搜尋皆正常）'],
            ['failed', '紅燈（任一失敗）'],
            ['untested', '未測試'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type='button'
            onClick={() => setStatusFilter(value)}
            aria-pressed={statusFilter === value}
            className={`min-h-9 cursor-pointer rounded-full border px-3 text-xs font-medium transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              statusFilter === value
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 text-gray-700 hover:border-blue-500 hover:text-blue-700 dark:border-gray-600 dark:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
        <span className='ml-auto text-xs text-gray-500 dark:text-gray-400'>
          {probedAt
            ? `上次全部測試：${formatRelativeTime(probedAt)}（${new Date(
                probedAt
              ).toLocaleString('zh-TW')}）`
            : '尚未做過完整測試'}
        </span>
      </div>

      {error && (
        <div
          role='alert'
          className='rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300'
        >
          {error}
        </div>
      )}

      {!loaded ? (
        <div className='space-y-2' aria-busy='true' aria-live='polite'>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className='h-14 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800'
            />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className='rounded-lg bg-gray-50 px-4 py-8 text-center text-sm text-gray-500 dark:bg-gray-800/60 dark:text-gray-400'>
          沒有符合條件的漫畫源
        </div>
      ) : (
        <ul className='max-h-[60vh] space-y-2 overflow-y-auto pr-1'>
          {visible.map((source) => {
            const busy = busyIds.has(source.id);
            const isSelected = selected.has(source.id);
            return (
              <li
                key={source.id}
                className='flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700'
              >
                <label className='inline-flex min-h-11 cursor-pointer items-center'>
                  <span className='sr-only'>選取 {source.name}</span>
                  <input
                    type='checkbox'
                    checked={isSelected}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(source.id)) next.delete(source.id);
                        else next.add(source.id);
                        return next;
                      })
                    }
                    className='h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/40'
                  />
                </label>

                <button
                  type='button'
                  role='switch'
                  aria-checked={source.enabled}
                  aria-label={`${source.enabled ? '停用' : '啟用'} ${source.name}`}
                  onClick={() => toggle(source)}
                  disabled={busy}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
                    source.enabled
                      ? 'bg-green-600'
                      : 'bg-gray-300 dark:bg-gray-600'
                  } ${busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                      source.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>

                <div className='min-w-0 flex-1'>
                  <div className='truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {source.displayName || source.name}
                  </div>
                  <div className='mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400'>
                    <span>{source.lang || '—'}</span>
                    {source.contentWarning === 'NSFW' && (
                      <span className='rounded bg-pink-100 px-1.5 py-0.5 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300'>
                        成人
                      </span>
                    )}
                    {source.probe &&
                      (
                        [
                          ['熱門', source.probe.popular.error],
                          ['搜尋', source.probe.search.error],
                        ] as const
                      )
                        .filter(([, err]) => Boolean(err))
                        .map(([label, err]) => (
                          <span
                            key={label}
                            className='truncate text-red-600 dark:text-red-400'
                            title={err}
                          >
                            {label}：{(err || '').split('\n')[0].slice(0, 60)}
                          </span>
                        ))}
                  </div>
                </div>

                <SourceStatusBadge probe={source.probe} />

                <button
                  type='button'
                  onClick={() => runTest([source.id])}
                  disabled={busy || !!bulkBusy}
                  aria-label={`測試 ${source.name}`}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-gray-300 px-3 text-xs font-medium text-gray-700 transition-colors duration-200 hover:border-blue-500 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:text-gray-200 ${
                    busy || bulkBusy
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-pointer'
                  }`}
                >
                  <RefreshCw
                    aria-hidden='true'
                    className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`}
                  />
                  測試
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
