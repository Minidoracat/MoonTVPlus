'use client';

import { Flame, Search, Sparkles } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { deleteMangaShelf, getAllMangaShelf, saveMangaShelf } from '@/lib/db.client';
import { getMangaSourceCategory } from '@/lib/manga-source-groups';
import type {
  MangaFilterSelection,
  MangaSourceFilterOption,
  MangaSourceProbeSummary,
} from '@/lib/manga.types';
import {
  upsertFilterSelection,
  MangaRecommendResult,
  MangaRecommendType,
  MangaSearchItem,
  MangaShelfItem,
  MangaSource,
} from '@/lib/manga.types';

import CapsuleSwitch from '@/components/CapsuleSwitch';
import MangaCard from '@/components/MangaCard';
import MangaFilterGroupChips from '@/components/manga/MangaFilterGroupChips';
import MangaSourcePicker from '@/components/manga/MangaSourcePicker';

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

function mangaHomeHref(sourceId: string, type: MangaRecommendType): string {
  const params = new URLSearchParams();
  if (sourceId) params.set('sourceId', sourceId);
  params.set('type', type);
  const query = params.toString();
  return query ? `/manga?${query}` : '/manga';
}

function formatMangaRecommendError(message: string): string {
  const firstLine = message.split('\n')[0].replace(
    /^Exception while fetching data \([^)]+\) :\s*/i,
    ''
  );
  if (/使用者ID|用户ID|Token/i.test(firstLine)) {
    return '這個源需要在 Suwayomi 外掛設定填使用者 ID／Token（從官方 APP 複製），不是網址錯誤。';
  }
  if (/修改网址|修改網址/.test(firstLine)) {
    return '這個源要求在外掛設定裡改成目前可用的網址。';
  }
  return firstLine.slice(0, 180);
}

export default function MangaRecommendPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  /*
   * `null` 代表「還沒載入完」，`[]` 才是「確實沒有可用來源」。
   * 用初值 `[]` 的話，`/api/manga/sources` 還在飛的時候畫面就會斷言
   * 「暂无可用漫画源」—— 與本輪修掉的「当前源暂无推荐内容」同一個誤報
   * 家族（拿空集合的初值去斷言空結果）。
   */
  const [sources, setSources] = useState<MangaSource[] | null>(null);
  const [sourceProbe, setSourceProbe] = useState<
    Record<string, MangaSourceProbeSummary>
  >({});
  const [sourceId, setSourceId] = useState(
    () => searchParams.get('sourceId') || ''
  );
  const [recommendType, setRecommendType] = useState<MangaRecommendType>(() =>
    searchParams.get('type')?.toUpperCase() === 'LATEST' ? 'LATEST' : 'POPULAR'
  );
  const [result, setResult] = useState<MangaRecommendResult>({ mangas: [], hasNextPage: false });
  const [page, setPage] = useState(1);
  /*
   * 初值跟著 sourceId：URL 帶了 sourceId 時，第一次 render（含 SSR）就該是
   * 載入中，否則 result.mangas 是空陣列而 loading 為 false，畫面會斷言
   * 「当前源暂无推荐内容」—— 實測 SSR 回傳的 HTML 確實含這句，使用者在
   * hydration 與第一次 fetch 完成前就看到它。換來源那一路徑由 render 期的
   * setLoading(true) 負責，這裡只管初始掛載。
   */
  const [loading, setLoading] = useState(() => Boolean(sourceId));
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [shelf, setShelf] = useState<Record<string, MangaShelfItem>>({});
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const recommendRequestRef = useRef(0);
  const [sourceFilters, setSourceFilters] = useState<MangaSourceFilterOption[]>([]);
  /** 源內搜尋：輸入框內容與「已提交」的關鍵字分開 —— 打字過程中不該每個字都打上游 */
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [filterSelections, setFilterSelections] = useState<MangaFilterSelection[]>([]);
  const [filtersError, setFiltersError] = useState('');

  /*
   * 換來源時「在 render 期」重設，而不是在 effect 裡。
   *
   * 在 effect 裡重設會留下一個 render 窗口：那一輪 sourceId 已是新值，
   * keyword/filterSelections 卻還是舊來源的，於是同一輪建立的
   * fetchRecommend closure 會把使用者在前一個來源打的關鍵字送去新來源
   * （實測過，log 出現「新 sourceId + 舊 q」）。effect 內的 setState
   * 不會改寫已建立的 closure，requestId guard 也只能丟棄回應、無法收回
   * 已送出的 HTTP。
   *
   * React 會在跑 effect 之前先用新 state 重跑 render，所以 effect 看到的
   * closure 已經是乾淨值 —— 窗口從根本消失，不需要額外的 override 參數或
   * ref，也少掉「先用舊值抓一次、再用新值抓一次」的多餘請求。
   */
  const [paramsSourceId, setParamsSourceId] = useState(sourceId);
  if (paramsSourceId !== sourceId) {
    setParamsSourceId(sourceId);
    setSourceFilters([]);
    setFilterSelections([]);
    setFiltersError('');
    // 關鍵字也要跟著清：換來源後同一個關鍵字的搜尋範圍／分類語意都變了
    setKeywordInput('');
    setKeyword('');
    /*
     * 分頁面向也屬於舊來源，同樣要清：
     * - page 留著會讓 load-more 帶「新 sourceId + 舊頁碼」去抓
     * - result 留著更糟，append 只 concat 不比對 sourceId（見 fetchRecommend），
     *   新來源的結果會被併進舊來源的清單裡
     * - hasNextPage 留著會讓哨兵在新資料還沒回來前就觸發 load-more
     * 這與 effect 裡「sourceId 變空」那條分支的處理一致。
     */
    setResult({ mangas: [], hasNextPage: false });
    setPage(1);
    setError('');
    /*
     * 一併把 loading 設起來。清空 result 之後，若 loading 還是 false，
     * 這一次 commit 會走進「mangas 為空」那一臂而渲染「当前源暂无推荐内容」
     * —— 在我們還沒送出任何請求時就斷言新來源沒有內容。實際把 loading 設
     * true 的是下面那個 effect，但 effect 排在 paint 之後，中間有一個可被
     * 繪製的 frame。「sourceId 變空」的情況由那個 effect 顯式設回 false。
     */
    setLoading(true);
  }

  useEffect(() => {
    if (!sourceId) return;

    let cancelled = false;
    fetch(`/api/manga/filters?sourceId=${encodeURIComponent(sourceId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `读取来源分类失败（${res.status}）`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setSourceFilters(
          Array.isArray(data.filters)
            ? (data.filters as MangaSourceFilterOption[])
            : []
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // 讀取失敗不能偽裝成「這個源沒有分類」
        setFiltersError((err as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  useEffect(() => {
    if (typeof window !== 'undefined' && !(window as any).RUNTIME_CONFIG?.SUWAYOMI_ENABLED) {
      router.replace('/');
    }
  }, [router]);

  useEffect(() => {
    const query = searchParams.get('q')?.trim();
    if (!query) return;

    const params = new URLSearchParams(searchParams.toString());
    router.replace(`/manga/search?${params.toString()}`);
  }, [router, searchParams]);

  useEffect(() => {
    fetch('/api/manga/sources')
      .then((res) => res.json())
      .then((data) => {
        const nextSources = (data.sources || []) as MangaSource[];
        setSources(nextSources);
        // 管理員最近一次測試的燈號／延遲，供 picker 顯示
        setSourceProbe(data.probe || {});
        setSourceId((prev) => {
          const fromUrl = searchParams.get('sourceId') || '';
          if (fromUrl && nextSources.some((source) => source.id === fromUrl)) {
            return fromUrl;
          }
          if (prev && nextSources.some((source) => source.id === prev)) {
            return prev;
          }
          return (
            nextSources.find(
              (source) => getMangaSourceCategory(source) === 'safe'
            )?.id ||
            nextSources.find(
              (source) => getMangaSourceCategory(source) === 'mixed'
            )?.id ||
            ''
          );
        });
      })
      .catch(() => {
        // 失敗也要結束「載入中」，否則畫面永遠停在骨架。對使用者的意義
        // 與「確實沒有可用來源」相同：都無法選源。
        setSources([]);
      });

    getAllMangaShelf().then(setShelf).catch(() => undefined);
  }, []);

  const fetchRecommend = useCallback(async (nextPage: number, append: boolean) => {
    if (!sourceId) return;

    const requestId = ++recommendRequestRef.current;

    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setError('');
    }

    try {
      const params = new URLSearchParams({
        sourceId,
        type: recommendType,
        page: String(nextPage),
      });
      if (filterSelections.length > 0) {
        params.set('filters', JSON.stringify(filterSelections));
      }
      if (keyword) {
        params.set('q', keyword);
      }
      const res = await fetch(`/api/manga/recommend?${params.toString()}`);
      if (recommendRequestRef.current !== requestId) return;

      const data = (await res.json()) as MangaRecommendResult & { error?: string };
      if (recommendRequestRef.current !== requestId) return;
      if (!res.ok) throw new Error(data.error || '获取推荐失败');

      setPage(nextPage);
      setResult((prev) => ({
        mangas: append ? [...prev.mangas, ...data.mangas] : data.mangas,
        hasNextPage: data.hasNextPage,
      }));
      /*
       * 成功了就把 error 清掉。append 路徑沒有在開頭清（開頭只清 !append），
       * 留著會讓哨兵在之後真的到底時（hasNextPage 變 false）檢查到殘留的
       * error 而顯示重試按鈕 —— 使用者已經看完所有頁，卻被告知載入失敗，
       * 而且點下去又是「成功但沒有新資料」，永遠看不到「没有更多了」。
       */
      setError('');
    } catch (err) {
      if (recommendRequestRef.current !== requestId) return;
      setError(formatMangaRecommendError((err as Error).message));
      if (append) {
        /*
         * 「載入更多」失敗必須把 hasNextPage 收掉，否則會無限重打上游。
         *
         * 哨兵 div 在失敗後仍掛在 DOM 且仍在視窗內（失敗不改變版面，
         * 使用者也還停在底部），而 load-more effect 的 deps 含 loadingMore，
         * true→false 會讓它重跑 → disconnect 後重新 observe → observe() 對
         * 正在相交的元素會投遞一次初始 observation → 條件再次成立 → 再次
         * 失敗。錯誤訊息已經顯示給使用者，讓他決定要不要重試，比我們替他
         * 反覆去打漫畫站好。
         */
        setResult((prev) => ({ ...prev, hasNextPage: false }));
      } else {
        setResult({ mangas: [], hasNextPage: false });
      }
    } finally {
      if (recommendRequestRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filterSelections, keyword, recommendType, sourceId]);

  const listHref = useMemo(
    () => mangaHomeHref(sourceId, recommendType),
    [recommendType, sourceId]
  );

  useEffect(() => {
    if (searchParams.get('q')?.trim()) return;
    const currentHref = mangaHomeHref(
      searchParams.get('sourceId') || '',
      searchParams.get('type')?.toUpperCase() === 'LATEST' ? 'LATEST' : 'POPULAR'
    );
    if (currentHref === listHref) return;
    if (!sourceId && !searchParams.get('sourceId')) return;
    router.replace(listHref, { scroll: false });
  }, [listHref, router, searchParams, sourceId]);

  useEffect(() => {
    recommendRequestRef.current += 1;
    if (!sourceId) {
      setResult({ mangas: [], hasNextPage: false });
      setPage(1);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    void fetchRecommend(1, false);
  }, [fetchRecommend, sourceId]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && result.hasNextPage && !loading && !loadingMore) {
          void fetchRecommend(page + 1, true);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchRecommend, loading, loadingMore, page, result.hasNextPage]);



  const recommendOptions = [
    { label: '热门', value: 'POPULAR', icon: <Flame className='h-3.5 w-3.5' /> },
    { label: '最新', value: 'LATEST', icon: <Sparkles className='h-3.5 w-3.5' /> },
  ];

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
    <div className='mx-auto max-w-6xl space-y-6'>
      <section className='space-y-4 rounded-3xl border border-gray-200/70 bg-white/80 p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950/70 sm:p-5'>
        <div className='space-y-2'>
          <div className='text-sm font-medium text-gray-700 dark:text-gray-200'>漫画源</div>
          {sources === null ? (
            <div className='h-11 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-900' />
          ) : sources.length > 0 ? (
            <MangaSourcePicker
              sources={sources}
              value={sourceId}
              onChange={setSourceId}
              probe={sourceProbe}
            />
          ) : (
            <div className='rounded-2xl bg-gray-100 px-4 py-3 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400'>
              暂无可用漫画源
            </div>
          )}
        </div>

        {/* 源內搜尋：這個來源自己的 filter 有些就是為關鍵字設計的
            （實測禁漫天堂有「搜索范围」：站内搜索／作品／作者／标签／
            登场人物），沒有關鍵字時那些 filter 完全沒作用。
            與 /manga/search 互補：那邊是多源廣度、不套 filter。
            關鍵字刻意不進 URL —— /manga?q= 是既有的「跳去多源搜尋」入口，
            且 filter 本來就不進 URL，兩者行為一致。 */}
        {sourceId && (
          <div className='space-y-2'>
            <label
              htmlFor='manga-source-keyword'
              className='block text-sm font-medium text-gray-700 dark:text-gray-200'
            >
              在本源搜尋
            </label>
            <form
              className='flex gap-2'
              onSubmit={(event) => {
                event.preventDefault();
                setKeyword(keywordInput.trim());
              }}
            >
              <input
                id='manga-source-keyword'
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                placeholder='輸入關鍵字，可搭配下方分類／搜尋範圍'
                maxLength={200}
                className='h-11 min-w-0 flex-1 rounded-2xl border border-gray-200 bg-gray-50 px-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
              />
              <button
                type='submit'
                className='inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl bg-sky-600 px-4 text-sm font-medium text-white transition-colors duration-200 hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500'
              >
                <Search aria-hidden='true' className='h-4 w-4' />
                搜尋
              </button>
              {keyword && (
                <button
                  type='button'
                  onClick={() => {
                    setKeywordInput('');
                    setKeyword('');
                  }}
                  className='min-h-11 cursor-pointer rounded-2xl border border-gray-200 px-3 text-sm text-gray-700 transition-colors duration-200 hover:border-sky-500 hover:text-sky-600 dark:border-gray-700 dark:text-gray-200'
                >
                  清除
                </button>
              )}
            </form>
          </div>
        )}

        <div className='space-y-2'>
          <div className='text-sm font-medium text-gray-700 dark:text-gray-200'>推荐类型</div>
          {filterSelections.length > 0 || keyword ? (
            <p className='rounded-2xl bg-gray-100 px-4 py-3 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300'>
              {keyword
                ? `正在本源搜尋「${keyword}」，结果由关键字与筛选决定；清除后可再切换热门／最新。`
                : '已套用本源分类／排序，结果由该来源的筛选决定；清除筛选后可再切换热门／最新。'}
            </p>
          ) : (
            <CapsuleSwitch
              options={recommendOptions}
              active={recommendType}
              onChange={(value) => setRecommendType(value as MangaRecommendType)}
            />
          )}
        </div>

        {filtersError && (
          <div className='rounded-2xl bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'>
            {filtersError}
          </div>
        )}

        {sourceFilters.length > 0 && (
          <div className='space-y-2'>
            <div className='flex items-center justify-between'>
              <div className='text-sm font-medium text-gray-700 dark:text-gray-200'>
                本源分类 / 排序
              </div>
              {filterSelections.length > 0 && (
                <button
                  type='button'
                  onClick={() => setFilterSelections([])}
                  className='cursor-pointer text-xs text-gray-500 transition-colors duration-200 hover:text-sky-600 dark:text-gray-400'
                >
                  清除
                </button>
              )}
            </div>
            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'>
              {sourceFilters
                .filter(
                  (f): f is Extract<MangaSourceFilterOption, { kind: 'select' | 'sort' }> =>
                    f.kind === 'select' || f.kind === 'sort'
                )
                .map((filter) => {
                  const current = filterSelections.find(
                    (
                      item
                    ): item is Extract<
                      MangaFilterSelection,
                      { kind: 'select' | 'sort' }
                    > =>
                      item.position === filter.position &&
                      (item.kind === 'select' || item.kind === 'sort')
                  );
                  const selectId = `manga-filter-${filter.position}`;
                  return (
                    <div key={filter.position} className='space-y-1'>
                      <label
                        htmlFor={selectId}
                        className='block text-xs text-gray-500 dark:text-gray-400'
                      >
                        {filter.name}
                      </label>
                      <select
                        id={selectId}
                        value={current ? String(current.index) : ''}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setFilterSelections((prev) => {
                            if (raw === '') {
                              return upsertFilterSelection(prev, filter, null);
                            }
                            const index = Number(raw);
                            return upsertFilterSelection(
                              prev,
                              filter,
                              filter.kind === 'sort'
                                ? {
                                    position: filter.position,
                                    kind: 'sort',
                                    index,
                                    ascending: false,
                                  }
                                : {
                                    position: filter.position,
                                    kind: 'select',
                                    index,
                                  }
                            );
                          });
                        }}
                        className='h-11 w-full cursor-pointer rounded-2xl border border-gray-200 bg-gray-50 px-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
                      >
                        <option value=''>不限</option>
                        {filter.values.map((label, index) => (
                          <option key={`${filter.position}-${index}`} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              {/* 群組內單選下拉（喜漫的「分组标签」）：識別鍵是
                  (position, innerPosition) —— 同一群組的多個下拉共用頂層
                  position，rest 過濾若只比 position 會把兄弟下拉的選擇清掉 */}
              {sourceFilters
                .filter(
                  (f): f is Extract<MangaSourceFilterOption, { kind: 'group_select' }> =>
                    f.kind === 'group_select'
                )
                .map((filter) => {
                  const current = filterSelections.find(
                    (
                      item
                    ): item is Extract<
                      MangaFilterSelection,
                      { kind: 'group_select' }
                    > =>
                      item.kind === 'group_select' &&
                      item.position === filter.position &&
                      item.innerPosition === filter.innerPosition
                  );
                  const selectId = `manga-filter-${filter.position}-${filter.innerPosition}`;
                  return (
                    <div
                      key={`${filter.position}-${filter.innerPosition}`}
                      className='space-y-1'
                    >
                      <label
                        htmlFor={selectId}
                        className='block text-xs text-gray-500 dark:text-gray-400'
                      >
                        {filter.name}
                      </label>
                      <select
                        id={selectId}
                        value={current ? String(current.index) : ''}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setFilterSelections((prev) =>
                            upsertFilterSelection(
                              prev,
                              filter,
                              raw === ''
                                ? null
                                : {
                                    position: filter.position,
                                    kind: 'group_select',
                                    innerPosition: filter.innerPosition,
                                    index: Number(raw),
                                  }
                            )
                          );
                        }}
                        className='h-11 w-full cursor-pointer rounded-2xl border border-gray-200 bg-gray-50 px-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
                      >
                        <option value=''>不限</option>
                        {filter.values.map((label, index) => (
                          <option
                            key={`${filter.position}-${filter.innerPosition}-${index}`}
                            value={index}
                          >
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              {/* 頂層單一勾選（少見，vomic 等 2 顆來源）：與下拉同格擺放 */}
              {sourceFilters
                .filter(
                  (f): f is Extract<MangaSourceFilterOption, { kind: 'checkbox' }> =>
                    f.kind === 'checkbox'
                )
                .map((filter) => {
                  const checked = filterSelections.some(
                    (item) =>
                      item.position === filter.position &&
                      item.kind === 'checkbox' &&
                      item.checked
                  );
                  return (
                    <label
                      key={filter.position}
                      className='flex min-h-11 cursor-pointer items-end gap-2 pb-2 text-sm text-gray-700 dark:text-gray-200'
                    >
                      <input
                        type='checkbox'
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked;
                          setFilterSelections((prev) =>
                            upsertFilterSelection(
                              prev,
                              filter,
                              // 未勾 = 不送（來源預設值），不送 checked: false
                              next
                                ? {
                                    position: filter.position,
                                    kind: 'checkbox',
                                    checked: true,
                                  }
                                : null
                            )
                          );
                        }}
                        className='h-4 w-4 cursor-pointer rounded border-gray-300 text-sky-600 focus:ring-2 focus:ring-sky-500/40'
                      />
                      {filter.name}
                    </label>
                  );
                })}
            </div>
            {/* 分類多選群組：chip 佔滿寬度，放在下拉 grid 之外 */}
            {sourceFilters
              .filter(
                (f): f is Extract<MangaSourceFilterOption, { kind: 'group' }> =>
                  f.kind === 'group'
              )
              .map((filter) => {
                const current = filterSelections.find(
                  (item): item is Extract<MangaFilterSelection, { kind: 'group' }> =>
                    item.position === filter.position && item.kind === 'group'
                );
                return (
                  <MangaFilterGroupChips
                    key={filter.position}
                    name={filter.name}
                    options={filter.options}
                    selected={current?.positions ?? []}
                    onToggle={(innerPosition) => {
                      // 方向（勾↔取消）也在 updater 內從 prev 判斷：
                      // 若由 child 用 render-time 的 selected 算方向，
                      // 「清除後立刻點選」那一下會被算成取消而被吞掉
                      setFilterSelections((prev) => {
                        const existing = prev.find(
                          (item): item is Extract<MangaFilterSelection, { kind: 'group' }> =>
                            item.position === filter.position &&
                            item.kind === 'group'
                        );
                        const currentPositions = existing?.positions ?? [];
                        const nextPositions = currentPositions.includes(
                          innerPosition
                        )
                          ? currentPositions.filter(
                              (item) => item !== innerPosition
                            )
                          : [...currentPositions, innerPosition];
                        // 全部取消勾選 = 移除這個 filter，不送空陣列
                        return upsertFilterSelection(
                          prev,
                          filter,
                          nextPositions.length > 0
                            ? {
                                position: filter.position,
                                kind: 'group',
                                positions: nextPositions,
                              }
                            : null
                        );
                      });
                    }}
                    onClear={() => {
                      setFilterSelections((prev) =>
                        upsertFilterSelection(prev, filter, null)
                      );
                    }}
                  />
                );
              })}
          </div>
        )}
      </section>

      <section>
        <div className='mb-4 flex items-center justify-between'>
          <h2 className='text-lg font-semibold'>推荐内容</h2>
        </div>

        {error && <div className='mb-4 text-sm text-red-500'>{error}</div>}

        {loading ? (
          <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
            {Array.from({ length: 12 }).map((_, index) => (
              <MangaCardSkeleton key={index} withButton />
            ))}
          </div>
        ) : result.mangas.length === 0 ? (
          <div className='rounded-2xl bg-gray-50 p-10 text-center text-sm text-gray-500 dark:bg-gray-900/50'>
            {sourceId ? '当前源暂无推荐内容' : '请先选择漫画源'}
          </div>
        ) : (
          <>
            <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
              {result.mangas.map((item) => {
                const key = `${item.sourceId}+${item.id}`;
                return (
                  <div key={key} className='space-y-2'>
                    <MangaCard
                      item={item}
                      href={`/manga/detail?mangaId=${item.id}&sourceId=${item.sourceId}&title=${encodeURIComponent(item.title)}&cover=${encodeURIComponent(item.cover)}&sourceName=${encodeURIComponent(item.sourceName)}&description=${encodeURIComponent(item.description || '')}&author=${encodeURIComponent(item.author || '')}&status=${encodeURIComponent(item.status || '')}&returnTo=${encodeURIComponent(listHref)}`}
                      subtitle={item.author || item.status || item.description}
                      badge={
                        keyword
                          ? '搜尋'
                          : filterSelections.length > 0
                            ? '筛选'
                            : recommendType === 'POPULAR'
                              ? '热门'
                              : '最新'
                      }
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

            {/* 哨兵不能在載入失敗時說「没有更多了」：觸發載入更多的前提就是
                使用者已經捲到底部，而錯誤訊息渲染在整個卡片 grid 之上、視窗外
                （實測差 5479px），他看到的只有這一行。宣告一個假的結束會讓他
                以為目錄到底而停止瀏覽。

                也不能叫他「刷新重试」：filterSelections 與 keyword 都是純 state、
                從不寫進 URL（mangaHomeHref 只放 sourceId 與 type），重新整理會把
                他選好的分類／排序／群組 chip／源內關鍵字全部清成初始值。而暫時性
                失敗重整後常常真的有結果，他不會意識到條件掉了。

                所以這裡給重試按鈕：狀態全都還在，單次重發即可。不會重開無限
                重打迴圈 —— observer 看的是 result.hasNextPage（失敗時已收成
                false），只有手動點擊會觸發。 */}
            <div ref={loadMoreRef} className='mt-6 flex min-h-10 items-center justify-center text-sm text-gray-500 dark:text-gray-400'>
              {loadingMore ? (
                '正在加载更多...'
              ) : result.hasNextPage ? (
                '继续下滑加载更多'
              ) : error ? (
                <button
                  type='button'
                  onClick={() => void fetchRecommend(page + 1, true)}
                  className='min-h-11 rounded-2xl border border-gray-200 px-4 text-sm font-medium text-sky-600 transition-colors hover:border-sky-500 hover:text-sky-700 dark:border-gray-700 dark:text-sky-400 dark:hover:border-sky-500'
                >
                  载入更多失败，点击重试
                </button>
              ) : (
                '没有更多了'
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
