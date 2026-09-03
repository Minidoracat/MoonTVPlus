'use client';

import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  List,
  Minimize2,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  deleteMangaShelf,
  getAllMangaReadRecords,
  getAllMangaShelf,
  MangaShelfMutationCancelledError,
  saveMangaReadRecord,
  saveMangaShelf,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import type {
  MangaChapter,
  MangaDetail,
  MangaReadRecord,
  MangaShelfItem,
} from '@/lib/manga.types';
import {
  buildMangaReadHref,
  buildMangaShelfItem,
  getHorizontalPageIndex,
  getHorizontalPageOffset,
  getNextMangaChapter,
  getReaderProgress,
  getReaderStartPage,
  isVerticalRestoreWindowSettled,
  orderMangaChapters,
  shouldEagerLoadVerticalRestorePage,
} from '@/lib/manga-reader';
import { processImageUrl } from '@/lib/utils';

import ProxyImage from '@/components/ProxyImage';

type ReadMode = 'single' | 'double' | 'vertical' | 'horizontal';
type ScaleMode = 'fit' | 'original';

const READ_MODE_STORAGE_KEY = 'mangaReadMode';
const SCALE_MODE_STORAGE_KEY = 'mangaScaleMode';
const PAGE_GAP_STORAGE_KEY = 'mangaPageGap';
const SAVE_INTERVAL_MS = 10000;
const PRELOAD_PAGE_COUNT = 5;
const VERTICAL_RESTORE_TIMEOUT_MS = 4000;
const SHELF_SYNC_RETRY_MS = 30_000;

const READ_MODE_OPTIONS: Array<{ value: ReadMode; label: string }> = [
  { value: 'single', label: '单页' },
  { value: 'double', label: '双页' },
  { value: 'vertical', label: '垂直滚动' },
  { value: 'horizontal', label: '水平滚动' },
];

const SCALE_MODE_OPTIONS: Array<{ value: ScaleMode; label: string }> = [
  { value: 'fit', label: '适配屏幕' },
  { value: 'original', label: '原始大小' },
];

function MangaReadSkeleton({
  readMode,
  pageGap,
}: {
  readMode: ReadMode;
  pageGap: number;
}) {
  if (readMode === 'horizontal') {
    return (
      <div
        className='flex min-h-[calc(100vh-8rem)] overflow-hidden'
        style={{ gap: `${pageGap}px` }}
      >
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className='flex min-w-full items-center justify-center px-1'
          >
            <div className='h-full min-h-[calc(100vh-8rem)] w-full animate-pulse bg-gray-100 dark:bg-gray-900' />
          </div>
        ))}
      </div>
    );
  }

  if (readMode === 'single' || readMode === 'double') {
    return (
      <div className='flex min-h-[calc(100vh-8rem)] items-center justify-center'>
        <div
          className={`grid w-full max-w-6xl ${
            readMode === 'double' ? 'md:grid-cols-2' : 'grid-cols-1'
          }`}
          style={{ gap: `${pageGap}px` }}
        >
          {Array.from({ length: readMode === 'double' ? 2 : 1 }).map(
            (_, index) => (
              <div
                key={index}
                className='min-h-[calc(100vh-8rem)] animate-pulse bg-gray-100 dark:bg-gray-900'
              />
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col' style={{ gap: `${pageGap}px` }}>
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className='aspect-[3/4] animate-pulse bg-gray-100 dark:bg-gray-900'
        />
      ))}
    </div>
  );
}

/** MangaLayout 靠這個事件收起 header；事件名是兩邊共用的契約。 */
function dispatchImmersiveChange(next: boolean) {
  window.dispatchEvent(
    new CustomEvent('manga-read-immersive-change', { detail: next })
  );
}

function dispatchControlsChange(visible: boolean) {
  window.dispatchEvent(
    new CustomEvent('manga-read-controls-change', { detail: visible })
  );
}
/**
 * 全站 CSS 讓某些 viewport 由 body 自己捲動（html 高度固定）。
 * 同時取兩者可讓 reader 在 desktop／mobile 與 fullscreen 使用同一套邊界。
 */
const getReaderScrollTop = () =>
  Math.max(
    window.scrollY,
    document.documentElement.scrollTop,
    document.body.scrollTop
  );

const getReaderScrollHeight = () =>
  Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);

const scrollReaderBy = (top: number, behavior: ScrollBehavior) => {
  if (document.body.scrollHeight > document.documentElement.scrollHeight) {
    document.body.scrollBy({ top, behavior });
    return;
  }
  window.scrollBy({ top, behavior });
};

const scrollReaderTo = (top: number, behavior: ScrollBehavior) => {
  if (document.body.scrollHeight > document.documentElement.scrollHeight) {
    document.body.scrollTo({ top, behavior });
    return;
  }
  window.scrollTo({ top, behavior });
};

export default function MangaReadPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const mangaId = searchParams.get('mangaId') || '';
  const sourceId = searchParams.get('sourceId') || '';
  const chapterId = searchParams.get('chapterId') || '';
  const title = searchParams.get('title') || '漫画阅读';
  const cover = searchParams.get('cover') || '';
  const sourceName = searchParams.get('sourceName') || sourceId;
  const chapterName = searchParams.get('chapterName') || '章节';
  const returnTo = searchParams.get('returnTo') || '/manga';
  /** 章節列表／下一話明確帶入，優先於歷史續讀紀錄 */
  const startAtFirstPage = searchParams.get('startPage') === '1';
  const chapterRestoreKey = `${sourceId}+${mangaId}+${chapterId}`;
  const historyRestoreToken = `${chapterRestoreKey}:${
    startAtFirstPage ? 'first' : 'resume'
  }`;
  const mangaDetailRequestKey = `${sourceId}+${mangaId}`;

  const [pages, setPages] = useState<string[]>([]);
  const [pagesLoading, setPagesLoading] = useState(() => Boolean(chapterId));
  const [pagesError, setPagesError] = useState('');
  const [activePage, setActivePage] = useState(0);
  const [progressDraft, setProgressDraft] = useState<number | null>(null);
  const [readMode, setReadMode] = useState<ReadMode>('vertical');
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit');
  const [pageGap, setPageGap] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chapterListOpen, setChapterListOpen] = useState(false);
  const [chapterListDesc, setChapterListDesc] = useState(false);
  const [mangaDetail, setMangaDetail] = useState<MangaDetail | null>(null);
  const [mangaDetailError, setMangaDetailError] = useState('');
  const [mangaDetailLoading, setMangaDetailLoading] = useState(() =>
    Boolean(mangaId && sourceId)
  );
  const [showChapterComplete, setShowChapterComplete] = useState(false);
  const [shelf, setShelf] = useState<Record<string, MangaShelfItem>>({});
  const [shelfSaving, setShelfSaving] = useState(false);
  const [shelfLoaded, setShelfLoaded] = useState(false);
  /** CSS 沉浸模式永遠可用；瀏覽器 Fullscreen API 可用時再加上真正 fullscreen */
  const [immersiveMode, setImmersiveMode] = useState(false);
  const [historyRestorePending, setHistoryRestorePending] = useState(() =>
    Boolean(chapterId)
  );
  const [verticalRestoreActive, setVerticalRestoreActive] = useState(false);
  /**
   * 「重新载入当前页」用的 cache-busting token，key 是 page index。
   * 只有被點過重載的頁會拿到 token，其餘頁維持原本的 URL 與快取行為。
   */
  const [pageReloadTokens, setPageReloadTokens] = useState<
    Record<number, number>
  >({});

  const verticalPageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const horizontalContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingRecordRef = useRef<MangaReadRecord | null>(null);
  const pendingRecordDirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const restoredChapterKeyRef = useRef<string | null>(null);
  const previousReadModeRef = useRef<ReadMode>('vertical');
  const requestVerticalPageSyncRef = useRef<(() => void) | null>(null);
  const currentVerticalPageIndexRef = useRef(0);
  const progressDraftRef = useRef<number | null>(null);
  const preloadedImageUrlsRef = useRef<Set<string>>(new Set());
  const activeChapterRef = useRef<HTMLAnchorElement | null>(null);
  const chapterScrollerRef = useRef<HTMLDivElement | null>(null);
  const mangaDetailOwnerRef = useRef('');
  const shelfSyncAttemptRef = useRef<{
    inflight: boolean;
    signature: string;
    timer: number | null;
  } | null>(null);
  /** pages 目前屬於哪一話；防止「新 chapterId + 舊 pages」寫入髒紀錄 */
  const pagesChapterIdRef = useRef('');
  const pendingRecordVersionRef = useRef(0);
  /**
   * vertical 續讀以 target 鄰近圖片提早 settle，另有 timeout 保證不會因
   * 上游圖片永久 pending 而鎖住 scroll/page sync。
   */
  const pendingVerticalRestorePageRef = useRef<number | null>(null);
  const settledVerticalPagesRef = useRef<Set<number>>(new Set());
  const loadedVerticalPagesRef = useRef<Set<number>>(new Set());
  const verticalRestoreTimeoutRef = useRef<number | null>(null);
  const historyRestorePendingRef = useRef(Boolean(chapterId));
  const historyRestoreVersionRef = useRef(0);
  const verticalRestoreGenerationRef = useRef(0);
  const immersiveDesiredRef = useRef(false);
  const mangaDetailIsCurrent =
    mangaDetailOwnerRef.current === mangaDetailRequestKey;
  const ownedMangaDetail = mangaDetailIsCurrent ? mangaDetail : null;
  const ownedMangaDetailError = mangaDetailIsCurrent ? mangaDetailError : '';
  const ownedMangaDetailLoading = !mangaDetailIsCurrent || mangaDetailLoading;
  const getCurrentVerticalPageIndex = () => {
    const pageNodes = verticalPageRefs.current;
    if (!pageNodes.length) return 0;
    const topAnchor = 80;
    let low = 0;
    let high = pageNodes.length - 1;
    let currentIndex = 0;

    while (low <= high) {
      const index = Math.floor((low + high) / 2);
      const node = pageNodes[index];
      if (!node || node.getBoundingClientRect().top > topAnchor) {
        high = index - 1;
      } else {
        currentIndex = index;
        low = index + 1;
      }
    }

    return currentIndex;
  };

  /** 垂直／水平模式的定位邏輯；單頁／雙頁模式不需要滾動。 */
  const scrollToPage = useCallback(
    (page: number, behavior: ScrollBehavior) => {
      if (readMode === 'vertical') {
        verticalPageRefs.current[page]?.scrollIntoView({
          block: 'start',
          behavior,
        });
        return;
      }
      if (readMode === 'horizontal') {
        const container = horizontalContainerRef.current;
        container?.scrollTo({
          left: getHorizontalPageOffset(page, container.clientWidth, pageGap),
          behavior,
        });
      }
    },
    [pageGap, readMode]
  );

  const clearVerticalRestoreTimeout = useCallback(() => {
    if (verticalRestoreTimeoutRef.current === null) return;
    window.clearTimeout(verticalRestoreTimeoutRef.current);
    verticalRestoreTimeoutRef.current = null;
  }, []);

  const cancelVerticalRestore = useCallback(() => {
    verticalRestoreGenerationRef.current += 1;
    pendingVerticalRestorePageRef.current = null;
    setVerticalRestoreActive(false);
    clearVerticalRestoreTimeout();
  }, [clearVerticalRestoreTimeout]);

  const finishVerticalRestore = useCallback(
    (target: number, generation: number) => {
      if (
        generation !== verticalRestoreGenerationRef.current ||
        pendingVerticalRestorePageRef.current !== target
      ) {
        return;
      }
      pendingVerticalRestorePageRef.current = null;
      clearVerticalRestoreTimeout();
      window.requestAnimationFrame(() => {
        if (generation !== verticalRestoreGenerationRef.current) return;
        // 先用 placeholder 幾何把 viewport 放到 target，再 mount 其他 lazy 圖；
        // 否則 browser 會在 scroll 前先預抓頁首 0..N。
        scrollToPage(target, 'auto');
        window.requestAnimationFrame(() => {
          if (generation !== verticalRestoreGenerationRef.current) return;
          setVerticalRestoreActive(false);
          window.requestAnimationFrame(() => {
            if (generation === verticalRestoreGenerationRef.current) {
              requestVerticalPageSyncRef.current?.();
            }
          });
        });
      });
    },
    [clearVerticalRestoreTimeout, scrollToPage]
  );

  const armVerticalRestore = useCallback(
    (target: number) => {
      cancelVerticalRestore();
      if (target <= 0) return;
      const generation = verticalRestoreGenerationRef.current;
      pendingVerticalRestorePageRef.current = target;
      setVerticalRestoreActive(true);
      if (
        isVerticalRestoreWindowSettled(settledVerticalPagesRef.current, target)
      ) {
        finishVerticalRestore(target, generation);
        return;
      }
      verticalRestoreTimeoutRef.current = window.setTimeout(
        () => finishVerticalRestore(target, generation),
        VERTICAL_RESTORE_TIMEOUT_MS
      );
    },
    [cancelVerticalRestore, finishVerticalRestore]
  );

  const handleVerticalImageSettled = (index: number, loaded: boolean) => {
    settledVerticalPagesRef.current.add(index);
    if (loaded) {
      loadedVerticalPagesRef.current.add(index);
      verticalPageRefs.current[index]?.style.removeProperty('min-height');
    }

    const target = pendingVerticalRestorePageRef.current;
    if (target === null) {
      if (!verticalRestoreActive) {
        requestVerticalPageSyncRef.current?.();
      }
      return;
    }
    const generation = verticalRestoreGenerationRef.current;
    if (
      isVerticalRestoreWindowSettled(settledVerticalPagesRef.current, target)
    ) {
      finishVerticalRestore(target, generation);
      return;
    }

    window.requestAnimationFrame(() => {
      if (
        generation === verticalRestoreGenerationRef.current &&
        pendingVerticalRestorePageRef.current === target
      ) {
        scrollToPage(target, 'auto');
      }
    });
  };

  const getPreloadAnchorPage = () =>
    readMode === 'vertical' ? currentVerticalPageIndexRef.current : activePage;

  const getImageLoadingStrategy = (index: number): 'eager' | 'lazy' => {
    const restoreTarget = pendingVerticalRestorePageRef.current;
    if (
      restoreTarget !== null &&
      shouldEagerLoadVerticalRestorePage(
        index,
        restoreTarget,
        PRELOAD_PAGE_COUNT
      )
    ) {
      return 'eager';
    }
    const anchorPage = getPreloadAnchorPage();
    return index >= Math.max(anchorPage - 1, 0) &&
      index <= anchorPage + PRELOAD_PAGE_COUNT
      ? 'eager'
      : 'lazy';
  };

  /**
   * 重抓目前畫面的圖片，不動 activePage、捲動位置、章節或閱讀設定。
   * 雙頁模式的兩張都屬於目前畫面；其他模式只重抓 active page。
   */
  const reloadCurrentPage = () => {
    if (!pages.length) return;
    const raw =
      readMode === 'vertical'
        ? currentVerticalPageIndexRef.current
        : activePage;
    const index = Math.min(Math.max(raw, 0), pages.length - 1);
    const reloadIndexes =
      readMode === 'double' && index + 1 < pages.length
        ? [index, index + 1]
        : [index];

    // 垂直模式先釘住容器高度；成功載入才移除，失敗時保留避免頁面塌陷。
    if (readMode === 'vertical') {
      const node = verticalPageRefs.current[index];
      const height = node?.getBoundingClientRect().height ?? 0;
      if (node && height > 0) node.style.minHeight = `${height}px`;
    }
    setPageReloadTokens((prev) => {
      const next = { ...prev };
      for (const pageIndex of reloadIndexes) {
        next[pageIndex] = (next[pageIndex] ?? 0) + 1;
      }
      return next;
    });
  };

  /** 換話後舊 token 不再對應任何頁，直接清掉。 */
  useEffect(() => {
    setPageReloadTokens((prev) => (Object.keys(prev).length ? {} : prev));
  }, [chapterId]);

  /** 沒有 token 時回傳 undefined，讓 ProxyImage 走它原本的 URL 解析。 */
  const getPageDisplaySrc = (page: string, index: number) => {
    const token = pageReloadTokens[index];
    if (!token) return undefined;
    const resolved = processImageUrl(page);
    if (!resolved) return undefined;
    return `${resolved}${resolved.includes('?') ? '&' : '?'}_reload=${token}`;
  };

  /** token 變更就換 key：舊的 retry／onLoad 不能覆蓋重載後的那張圖。 */
  const getPageRenderKey = (index: number) =>
    `page-${index}-${pageReloadTokens[index] ?? 0}`;

  /**
   * 在 UI 操作／scroll event 當下同步 stage 紀錄，不等待 React passive effect。
   * 否則 slider change 後立刻按 SPA 返回，state 尚未 commit，cleanup 看到的
   * pendingRecord 仍是空的，整次閱讀不會留下歷史。
   */
  const stagePendingRecord = useCallback(
    (pageIndex: number) => {
      if (
        historyRestorePendingRef.current ||
        !pages.length ||
        pagesChapterIdRef.current !== chapterId ||
        !mangaId ||
        !sourceId ||
        !chapterId
      ) {
        return;
      }
      pendingRecordRef.current = {
        title,
        cover,
        sourceId,
        sourceName,
        mangaId,
        chapterId,
        chapterName,
        pageIndex,
        pageCount: pages.length,
        saveTime: Date.now(),
      };
      pendingRecordVersionRef.current += 1;
      pendingRecordDirtyRef.current = true;
    },
    [
      chapterId,
      chapterName,
      cover,
      mangaId,
      pages.length,
      sourceId,
      sourceName,
      title,
    ]
  );

  const applyImmersiveMode = useCallback((next: boolean) => {
    immersiveDesiredRef.current = next;
    setImmersiveMode(next);
    setControlsVisible(true);
    setSettingsOpen(false);
    setChapterListOpen(false);
    dispatchImmersiveChange(next);

    if (next) {
      // iOS Safari 沒有 documentElement.requestFullscreen；CSS 沉浸模式仍會生效
      const request = document.documentElement.requestFullscreen?.();
      if (request) {
        void request
          .then(() => {
            // 使用者可能在 Promise settle 前已退出；不能讓晚到的成功重新進全螢幕
            if (!immersiveDesiredRef.current && document.fullscreenElement) {
              return document.exitFullscreen();
            }
            return undefined;
          })
          .catch(() => undefined);
      }
    } else if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  }, []);

  const toggleImmersiveMode = useCallback(() => {
    applyImmersiveMode(!immersiveMode);
  }, [applyImmersiveMode, immersiveMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedMode = window.localStorage.getItem(
      READ_MODE_STORAGE_KEY
    ) as ReadMode | null;
    if (
      savedMode &&
      READ_MODE_OPTIONS.some((item) => item.value === savedMode)
    ) {
      setReadMode(savedMode);
    }
    const savedScaleMode = window.localStorage.getItem(
      SCALE_MODE_STORAGE_KEY
    ) as ScaleMode | null;
    if (
      savedScaleMode &&
      SCALE_MODE_OPTIONS.some((item) => item.value === savedScaleMode)
    ) {
      setScaleMode(savedScaleMode);
    }
    const savedGap = Number(
      window.localStorage.getItem(PAGE_GAP_STORAGE_KEY) || 0
    );
    if (!Number.isNaN(savedGap)) {
      setPageGap(Math.min(Math.max(savedGap, 0), 48));
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(READ_MODE_STORAGE_KEY, readMode);
    window.localStorage.setItem(SCALE_MODE_STORAGE_KEY, scaleMode);
    window.localStorage.setItem(PAGE_GAP_STORAGE_KEY, String(pageGap));
  }, [pageGap, readMode, scaleMode]);

  useEffect(() => {
    dispatchControlsChange(controlsVisible);
  }, [controlsVisible]);

  useEffect(() => {
    const unsubscribe = subscribeToDataUpdates<Record<string, MangaShelfItem>>(
      'mangaShelfUpdated',
      (nextShelf) => {
        setShelf(nextShelf);
        setShelfLoaded(true);
      }
    );
    getAllMangaShelf({ throwOnError: true })
      .then((nextShelf) => {
        setShelf(nextShelf);
        setShelfLoaded(true);
      })
      .catch(() => setShelfLoaded(false));
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleToggleSettings = () => {
      setSettingsOpen((prev) => !prev);
      setControlsVisible(false);
      setChapterListOpen(false);
    };

    window.addEventListener('manga-read-toggle-settings', handleToggleSettings);
    return () => {
      window.removeEventListener(
        'manga-read-toggle-settings',
        handleToggleSettings
      );
    };
  }, []);

  useEffect(() => {
    const handleToggleChapters = () => {
      setChapterListOpen((prev) => !prev);
      setControlsVisible(false);
      setSettingsOpen(false);
    };

    window.addEventListener('manga-read-toggle-chapters', handleToggleChapters);
    return () => {
      window.removeEventListener(
        'manga-read-toggle-chapters',
        handleToggleChapters
      );
    };
  }, []);

  useEffect(() => {
    window.addEventListener('manga-read-toggle-immersive', toggleImmersiveMode);
    return () => {
      window.removeEventListener(
        'manga-read-toggle-immersive',
        toggleImmersiveMode
      );
    };
  }, [toggleImmersiveMode]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && immersiveMode) {
        immersiveDesiredRef.current = false;
        setImmersiveMode(false);
        setControlsVisible(true);
        dispatchImmersiveChange(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [immersiveMode]);

  /** 離開閱讀頁時同步退出 CSS 與 browser fullscreen，避免詳情頁仍卡全螢幕。 */
  useEffect(
    () => () => {
      immersiveDesiredRef.current = false;
      dispatchControlsChange(true);
      if (verticalRestoreTimeoutRef.current !== null) {
        window.clearTimeout(verticalRestoreTimeoutRef.current);
      }
      const shelfSyncTimer = shelfSyncAttemptRef.current?.timer;
      if (shelfSyncTimer !== null && shelfSyncTimer !== undefined) {
        window.clearTimeout(shelfSyncTimer);
      }
      shelfSyncAttemptRef.current = null;
      dispatchImmersiveChange(false);
      if (document.fullscreenElement) {
        void document.exitFullscreen?.().catch(() => undefined);
      }
    },
    []
  );

  useEffect(() => {
    // chapterId 變了就讓上一話的 fetch／restore generation 失效並清空頁面狀態。
    const hasReaderContext = Boolean(chapterId && mangaId && sourceId);
    verticalRestoreGenerationRef.current += 1;
    historyRestoreVersionRef.current += 1;
    historyRestorePendingRef.current = hasReaderContext;
    setHistoryRestorePending(hasReaderContext);
    setActivePage(0);
    progressDraftRef.current = null;
    setProgressDraft(null);
    restoredChapterKeyRef.current = null;
    preloadedImageUrlsRef.current.clear();
    settledVerticalPagesRef.current.clear();
    loadedVerticalPagesRef.current.clear();
    setVerticalRestoreActive(false);
    pendingVerticalRestorePageRef.current = null;
    if (verticalRestoreTimeoutRef.current !== null) {
      window.clearTimeout(verticalRestoreTimeoutRef.current);
      verticalRestoreTimeoutRef.current = null;
    }
    pagesChapterIdRef.current = '';
    if (!hasReaderContext) {
      setPages([]);
      setPagesLoading(false);
      setPagesError(chapterId ? '缺少作品或来源参数' : '缺少章节参数');
      return;
    }
    /*
     * chapterId 已變時，舊 pages 不能繼續留在畫面／restore effect 裡。
     * 先前新章 fetch 回來前會拿「新 chapterId + 舊 pages」去套閱讀紀錄，
     * 這是右上章節選單跳到尾頁的其中一個根因。
     */
    setPages([]);
    setPagesLoading(true);
    setPagesError('');
    verticalPageRefs.current = [];
    currentVerticalPageIndexRef.current = 0;
    const controller = new AbortController();
    let cancelled = false;

    fetch(`/api/manga/pages?chapterId=${encodeURIComponent(chapterId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || '无法载入章节内容');
        const nextPages = Array.isArray(data.pages) ? data.pages : [];
        if (nextPages.length === 0) {
          throw new Error('当前章节没有可阅读页面');
        }
        if (cancelled) return;
        pagesChapterIdRef.current = chapterId;
        setPages(nextPages);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPages([]);
        setPagesError(err instanceof Error ? err.message : '无法载入章节内容');
        historyRestorePendingRef.current = false;
        setHistoryRestorePending(false);
      })
      .finally(() => {
        if (!cancelled) setPagesLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [chapterId, mangaId, sourceId]);

  useEffect(() => {
    mangaDetailOwnerRef.current = '';
    setMangaDetail(null);
    setMangaDetailError('');
    if (!mangaId || !sourceId) {
      mangaDetailOwnerRef.current = mangaDetailRequestKey;
      setMangaDetailLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setMangaDetailLoading(true);
    const params = new URLSearchParams({
      mangaId,
      sourceId,
      title,
      cover,
      sourceName,
    });

    fetch(`/api/manga/detail?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || '无法载入作品章节列表');
        }
        if (!cancelled) {
          mangaDetailOwnerRef.current = mangaDetailRequestKey;
          setMangaDetail(data);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        mangaDetailOwnerRef.current = mangaDetailRequestKey;
        setMangaDetailError(
          err instanceof Error ? err.message : '无法载入作品章节列表'
        );
      })
      .finally(() => {
        if (!cancelled) setMangaDetailLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cover, mangaDetailRequestKey, mangaId, sourceId, sourceName, title]);

  useEffect(() => {
    if (
      !pages.length ||
      pagesChapterIdRef.current !== chapterId ||
      !mangaId ||
      !sourceId ||
      !chapterId
    ) {
      return;
    }

    if (restoredChapterKeyRef.current === historyRestoreToken) {
      historyRestorePendingRef.current = false;
      setHistoryRestorePending(false);
      return;
    }

    let cancelled = false;
    const requestVersion = historyRestoreVersionRef.current;
    const applyStartPage = (nextPage: number, consumeStartIntent = false) => {
      if (
        cancelled ||
        requestVersion !== historyRestoreVersionRef.current ||
        !historyRestorePendingRef.current ||
        pagesChapterIdRef.current !== chapterId
      ) {
        return;
      }

      setActivePage(nextPage);
      currentVerticalPageIndexRef.current = nextPage;
      if (readMode === 'vertical') {
        armVerticalRestore(nextPage);
      } else {
        cancelVerticalRestore();
      }
      historyRestorePendingRef.current = false;
      setHistoryRestorePending(false);
      restoredChapterKeyRef.current = consumeStartIntent
        ? `${chapterRestoreKey}:resume`
        : historyRestoreToken;
      stagePendingRecord(nextPage);
      window.setTimeout(() => scrollToPage(nextPage, 'auto'), 0);

      if (consumeStartIntent) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('startPage');
        router.replace(`/manga/read?${params.toString()}`, { scroll: false });
      }
    };

    // 明確選章固定第 1 頁，無須等待 history cache/network。
    if (startAtFirstPage) {
      applyStartPage(0, true);
      return () => {
        cancelled = true;
      };
    }

    getAllMangaReadRecords()
      .then((records) => {
        const record = records[`${sourceId}+${mangaId}`];
        applyStartPage(
          getReaderStartPage({
            forceFirstPage: false,
            record,
            chapterId,
            pageCount: pages.length,
          })
        );
      })
      .catch(() => applyStartPage(0));

    return () => {
      cancelled = true;
    };
  }, [
    armVerticalRestore,
    cancelVerticalRestore,
    chapterId,
    chapterRestoreKey,
    historyRestoreToken,
    mangaId,
    pages.length,
    readMode,
    router,
    scrollToPage,
    searchParams,
    sourceId,
    stagePendingRecord,
    startAtFirstPage,
  ]);

  useEffect(() => {
    setShowChapterComplete(false);
  }, [activePage, chapterId, readMode]);

  useEffect(() => {
    if (
      historyRestorePending ||
      readMode !== 'vertical' ||
      !pages.length ||
      !mangaId ||
      !sourceId ||
      !chapterId
    )
      return;

    let ticking = false;
    let rafId = 0;
    const updateActivePageFromViewport = () => {
      ticking = false;
      // restore 尚未 settle 時，placeholder／圖片高度仍可能變動；此時反推頁碼
      // 會把正確 target 覆寫成 viewport 中暫時可見的頁。
      if (pendingVerticalRestorePageRef.current !== null) return;
      const nextIndex = getCurrentVerticalPageIndex();
      currentVerticalPageIndexRef.current = nextIndex;
      setActivePage((prev) => (prev === nextIndex ? prev : nextIndex));
      stagePendingRecord(nextIndex);
    };

    const requestUpdate = () => {
      if (ticking) return;
      ticking = true;
      rafId = window.requestAnimationFrame(updateActivePageFromViewport);
    };

    requestVerticalPageSyncRef.current = requestUpdate;
    requestUpdate();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    document.body.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(requestUpdate);
      verticalPageRefs.current.forEach((node) => {
        if (node) resizeObserver?.observe(node);
      });
    }

    return () => {
      requestVerticalPageSyncRef.current = null;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', requestUpdate);
      document.body.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
      resizeObserver?.disconnect();
    };
  }, [
    chapterId,
    historyRestorePending,
    mangaId,
    pages,
    readMode,
    sourceId,
    stagePendingRecord,
  ]);

  useEffect(() => {
    if (readMode !== 'horizontal' || historyRestorePending) return;
    const container = horizontalContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      const page = getHorizontalPageIndex(
        container.scrollLeft,
        container.clientWidth,
        pageGap,
        pages.length
      );
      setActivePage(page);
      stagePendingRecord(page);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [
    historyRestorePending,
    pageGap,
    pages.length,
    readMode,
    stagePendingRecord,
  ]);

  useEffect(() => {
    if (!pages.length || historyRestorePending) {
      previousReadModeRef.current = readMode;
      return;
    }

    const previousReadMode = previousReadModeRef.current;
    previousReadModeRef.current = readMode;
    if (previousReadMode === readMode) return;

    const targetPage = Math.min(
      Math.max(activePage, 0),
      Math.max(pages.length - 1, 0)
    );

    window.setTimeout(() => scrollToPage(targetPage, 'auto'), 0);
  }, [activePage, historyRestorePending, pages.length, readMode, scrollToPage]);

  useEffect(() => {
    const currentPageIndex =
      readMode === 'vertical'
        ? currentVerticalPageIndexRef.current
        : activePage;
    stagePendingRecord(currentPageIndex);
  }, [activePage, readMode, stagePendingRecord]);

  useEffect(() => {
    if (typeof window === 'undefined' || !pages.length || historyRestorePending)
      return;

    const anchorPage = getPreloadAnchorPage();
    const preloadTargets = pages.slice(
      anchorPage + 1,
      anchorPage + 1 + PRELOAD_PAGE_COUNT
    );

    preloadTargets.forEach((page) => {
      const resolvedUrl = processImageUrl(page);
      if (!resolvedUrl || preloadedImageUrlsRef.current.has(resolvedUrl))
        return;

      const img = new window.Image();
      img.decoding = 'async';
      img.src = resolvedUrl;
      preloadedImageUrlsRef.current.add(resolvedUrl);
    });
  }, [activePage, historyRestorePending, pages, readMode]);

  useEffect(() => {
    if (!mangaId || !sourceId || !chapterId) return;

    const stageVisibleVerticalPage = () => {
      if (
        readMode !== 'vertical' ||
        pendingVerticalRestorePageRef.current !== null ||
        !verticalPageRefs.current.some((node) => node?.isConnected)
      ) {
        return;
      }

      const pageIndex = getCurrentVerticalPageIndex();
      const pending = pendingRecordRef.current;
      if (
        pending?.sourceId === sourceId &&
        pending.mangaId === mangaId &&
        pending.chapterId === chapterId &&
        pending.pageIndex === pageIndex
      ) {
        return;
      }
      currentVerticalPageIndexRef.current = pageIndex;
      stagePendingRecord(pageIndex);
    };

    const flushPendingRecord = () => {
      const record = pendingRecordRef.current;
      if (
        !record ||
        !pendingRecordDirtyRef.current ||
        saveInFlightRef.current
      ) {
        return;
      }

      const version = pendingRecordVersionRef.current;
      const recordToSave = { ...record, saveTime: Date.now() };

      // 先認領這個版本。儲存途中若使用者翻頁，新版會重新設 dirty；
      // 舊 Promise settle 時不得清掉或覆蓋新版 pending record。
      pendingRecordDirtyRef.current = false;
      saveInFlightRef.current = true;
      void saveMangaReadRecord(
        recordToSave.sourceId,
        recordToSave.mangaId,
        recordToSave
      )
        .catch(() => {
          // storage layer 已顯示錯誤並 recovery；不立即重試，保留 dirty 給下個 interval。
          if (pendingRecordVersionRef.current === version) {
            pendingRecordDirtyRef.current = true;
          }
        })
        .finally(() => {
          saveInFlightRef.current = false;
          if (
            pendingRecordDirtyRef.current &&
            pendingRecordVersionRef.current !== version
          ) {
            queueMicrotask(flushPendingRecord);
          }
        });
    };

    const stageAndFlushVisibleRecord = () => {
      stageVisibleVerticalPage();
      flushPendingRecord();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stageAndFlushVisibleRecord();
      }
    };

    const intervalId = window.setInterval(
      stageAndFlushVisibleRecord,
      SAVE_INTERVAL_MS
    );
    window.addEventListener('pagehide', stageAndFlushVisibleRecord);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      // React cleanup 可能晚於 DOM/ref detach，只能寫先前同步 stage 的 record。
      flushPendingRecord();
      window.clearInterval(intervalId);
      window.removeEventListener('pagehide', stageAndFlushVisibleRecord);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [chapterId, mangaId, readMode, sourceId, stagePendingRecord]);

  useEffect(() => {
    if (!mangaId || !sourceId || !chapterId || !ownedMangaDetail) return;

    const key = `${sourceId}+${mangaId}`;
    const orderedChapters = orderMangaChapters(ownedMangaDetail.chapters || []);
    const latestChapter = orderedChapters[orderedChapters.length - 1];
    // 未读数只代表「cron 侦测到的新章节」；进入阅读器即视为已看过更新，故归零。

    const clearPendingShelfSync = () => {
      const pending = shelfSyncAttemptRef.current;
      if (pending?.timer !== null && pending?.timer !== undefined) {
        window.clearTimeout(pending.timer);
      }
      shelfSyncAttemptRef.current = null;
    };
    const item = shelf[key];
    if (!item) {
      clearPendingShelfSync();
      return;
    }
    const nextItem: MangaShelfItem = {
      ...item,
      lastChapterId: chapterId,
      lastChapterName: chapterName,
      latestChapterId: latestChapter?.id || item.latestChapterId,
      latestChapterName: latestChapter?.name || item.latestChapterName,
      latestChapterCount: orderedChapters.length || item.latestChapterCount,
      unreadChapterCount: 0,
    };
    const changed =
      nextItem.lastChapterId !== item.lastChapterId ||
      nextItem.lastChapterName !== item.lastChapterName ||
      nextItem.latestChapterId !== item.latestChapterId ||
      nextItem.latestChapterName !== item.latestChapterName ||
      nextItem.latestChapterCount !== item.latestChapterCount ||
      nextItem.unreadChapterCount !== item.unreadChapterCount;
    if (!changed) {
      if (shelfSyncAttemptRef.current?.inflight === false) {
        clearPendingShelfSync();
      }
      return;
    }
    const syncSignature = JSON.stringify([
      key,
      nextItem.lastChapterId,
      nextItem.lastChapterName,
      nextItem.latestChapterId,
      nextItem.latestChapterName,
      nextItem.latestChapterCount,
      nextItem.unreadChapterCount,
    ]);
    if (shelfSyncAttemptRef.current?.signature === syncSignature) return;
    clearPendingShelfSync();

    const sync = (retriesLeft: number) => {
      const pending = shelfSyncAttemptRef.current;
      if (!pending || pending.signature !== syncSignature) return;
      pending.inflight = true;
      pending.timer = null;
      saveMangaShelf(sourceId, mangaId, nextItem)
        .then(() => {
          if (shelfSyncAttemptRef.current?.signature === syncSignature) {
            shelfSyncAttemptRef.current = null;
          }
        })
        .catch((error) => {
          const current = shelfSyncAttemptRef.current;
          if (!current || current.signature !== syncSignature) return;
          if (error instanceof MangaShelfMutationCancelledError) {
            shelfSyncAttemptRef.current = null;
            return;
          }
          current.inflight = false;
          if (retriesLeft <= 0) return;
          current.timer = window.setTimeout(() => {
            sync(retriesLeft - 1);
          }, SHELF_SYNC_RETRY_MS);
        });
    };

    shelfSyncAttemptRef.current = {
      inflight: false,
      signature: syncSignature,
      timer: null,
    };
    sync(1);
  }, [chapterId, chapterName, mangaId, ownedMangaDetail, shelf, sourceId]);

  /** 章節尾頁是否已經呈現在畫面上；章節完讀判斷與尾頁動作必須共用。 */
  const isLastPageVisible =
    pages.length > 0 &&
    (readMode === 'double'
      ? activePage >= Math.max(pages.length - 2, 0)
      : activePage >= pages.length - 1);

  const isAtChapterEnd = () => {
    if (!isLastPageVisible) return false;
    // 垂直模式，以及窄螢幕下「雙頁」實際是兩張單欄堆疊，都要真的滾到底；
    // 不能只因 logical activePage 已進最後一組就提前宣告完讀。
    const requiresScrollBottom =
      readMode === 'vertical' ||
      (readMode === 'double' && window.innerWidth < 768);
    if (!requiresScrollBottom) return true;
    return (
      getReaderScrollTop() + window.innerHeight >= getReaderScrollHeight() - 24
    );
  };

  const openChapterComplete = () => {
    if (!isAtChapterEnd()) return false;
    setShowChapterComplete(true);
    setControlsVisible(false);
    setSettingsOpen(false);
    return true;
  };

  const clampPage = (page: number) => {
    if (!pages.length) return 0;
    return Math.min(Math.max(page, 0), pages.length - 1);
  };

  const changeReadMode = (nextMode: ReadMode) => {
    if (nextMode === readMode) return;
    cancelVerticalRestore();
    if (nextMode === 'vertical' && !historyRestorePendingRef.current) {
      currentVerticalPageIndexRef.current = activePage;
      armVerticalRestore(activePage);
    }
    setReadMode(nextMode);
  };

  const seekToPage = (page: number, behavior: ScrollBehavior = 'smooth') => {
    const nextPage = clampPage(page);
    progressDraftRef.current = null;
    setProgressDraft(null);
    // slider／目前章節選擇取得 page ownership，讓仍在飛行的 history query 失效。
    historyRestoreVersionRef.current += 1;
    historyRestorePendingRef.current = false;
    setHistoryRestorePending(false);
    restoredChapterKeyRef.current = historyRestoreToken;
    setActivePage(nextPage);
    setShowChapterComplete(false);
    if (readMode === 'vertical') {
      currentVerticalPageIndexRef.current = nextPage;
      armVerticalRestore(nextPage);
    } else {
      cancelVerticalRestore();
    }
    stagePendingRecord(nextPage);
    window.setTimeout(() => scrollToPage(nextPage, behavior), 0);
  };

  const updateProgressDraft = (page: number) => {
    const nextPage = clampPage(page);
    progressDraftRef.current = nextPage;
    setProgressDraft(nextPage);
  };

  const commitProgressDraft = () => {
    const nextPage = progressDraftRef.current;
    if (nextPage === null) return;
    progressDraftRef.current = null;
    setProgressDraft(null);
    seekToPage(nextPage, 'auto');
  };

  const cancelProgressDraft = () => {
    progressDraftRef.current = null;
    setProgressDraft(null);
  };

  /** 垂直模式翻頁是視窗滾動，水平模式是容器捲動，單頁／雙頁則直接換頁碼。 */
  const stepPage = (direction: 1 | -1) => {
    const narrowDouble = readMode === 'double' && window.innerWidth < 768;
    const canScrollForward =
      getReaderScrollTop() + window.innerHeight < getReaderScrollHeight() - 24;
    if (
      readMode === 'vertical' ||
      (narrowDouble && direction === 1 && canScrollForward)
    ) {
      scrollReaderBy(direction * window.innerHeight * 0.85, 'smooth');
      return;
    }

    // 水平模式一次一頁、雙頁一次兩頁；scrollToPage 對單頁／雙頁是 no-op。
    const pageStep = readMode === 'double' ? 2 : 1;
    const nextPage = clampPage(activePage + direction * pageStep);
    setActivePage(nextPage);
    stagePendingRecord(nextPage);
    scrollToPage(nextPage, 'smooth');
    if (narrowDouble && direction === 1 && nextPage !== activePage) {
      window.setTimeout(() => scrollReaderTo(0, 'auto'), 0);
    }
  };

  const displayedPage = progressDraft ?? activePage;
  const progress = useMemo(
    () => getReaderProgress(displayedPage, pages.length),
    [displayedPage, pages.length]
  );

  const nextChapter = useMemo<MangaChapter | null>(
    () => getNextMangaChapter(ownedMangaDetail?.chapters || [], chapterId),
    [chapterId, ownedMangaDetail?.chapters]
  );

  const chapterList = useMemo(
    () => orderMangaChapters(ownedMangaDetail?.chapters || []),
    [ownedMangaDetail?.chapters]
  );

  const orderedChapterList = useMemo(
    () => (chapterListDesc ? [...chapterList].reverse() : chapterList),
    [chapterList, chapterListDesc]
  );
  const sourceCommentsUrl =
    chapterList.find((chapter) => chapter.id === chapterId)?.realUrl ||
    ownedMangaDetail?.realUrl;
  const shelfKey = `${sourceId}+${mangaId}`;
  const inShelf = Boolean(shelf[shelfKey]);
  const toggleReaderShelf = useCallback(async () => {
    if (!ownedMangaDetail || !shelfLoaded || shelfSaving) return;
    const pendingSync = shelfSyncAttemptRef.current;
    if (pendingSync?.timer !== null && pendingSync?.timer !== undefined) {
      window.clearTimeout(pendingSync.timer);
    }
    shelfSyncAttemptRef.current = null;
    setShelfSaving(true);
    try {
      if (shelf[shelfKey]) {
        await deleteMangaShelf(sourceId, mangaId);
      } else {
        await saveMangaShelf(
          sourceId,
          mangaId,
          buildMangaShelfItem({
            detail: ownedMangaDetail,
            currentChapter: { id: chapterId, name: chapterName },
            unreadChapterCount: 0,
          })
        );
      }
    } catch {
      // db.client 已顯示錯誤並用伺服器狀態回復 optimistic cache。
    } finally {
      setShelfSaving(false);
    }
  }, [
    chapterId,
    chapterName,
    mangaId,
    ownedMangaDetail,
    shelf,
    shelfKey,
    shelfLoaded,
    shelfSaving,
    sourceId,
  ]);

  /**
   * 使用者明確點章節列表／下一話時一律從第 1 頁開始。
   * 這是導航意圖，不等同從書架／歷史進來的「繼續閱讀」。
   */
  const chapterReadHref = (chapter: MangaChapter) =>
    buildMangaReadHref({
      mangaId,
      sourceId,
      chapterId: chapter.id,
      title,
      cover,
      sourceName,
      chapterName: chapter.name,
      returnTo,
      startAtFirstPage: true,
    });

  const detailHref = `/manga/detail?${new URLSearchParams({
    mangaId,
    sourceId,
    title,
    cover,
    sourceName,
    returnTo,
  }).toString()}`;

  const chapterEndAction = (
    <div className='flex min-h-[40vh] w-full items-center justify-center bg-black px-5 py-12 text-center text-white'>
      <div className='w-full max-w-sm space-y-4'>
        <div className='text-sm text-white/60'>{chapterName} 阅读完毕</div>
        {ownedMangaDetailError ? (
          <div className='rounded-2xl border border-amber-400/30 bg-amber-400/10 px-5 py-4 text-sm text-amber-100'>
            无法确认下一话：{ownedMangaDetailError}
          </div>
        ) : ownedMangaDetailLoading ? (
          <div className='rounded-2xl border border-white/15 px-5 py-4 text-sm text-white/70'>
            正在确认下一话…
          </div>
        ) : nextChapter ? (
          <Link
            href={chapterReadHref(nextChapter)}
            className='inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-sky-500 px-5 text-sm font-semibold text-white transition-colors hover:bg-sky-400'
          >
            下一话：{nextChapter.name}
          </Link>
        ) : (
          <div className='rounded-2xl border border-white/15 px-5 py-4 text-sm text-white/70'>
            已经是最新一话
          </div>
        )}
        {sourceCommentsUrl && (
          <a
            href={sourceCommentsUrl}
            target='_blank'
            rel='noreferrer'
            className='inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/20 px-4 text-sm text-white/80 transition-colors hover:border-white/40 hover:text-white'
          >
            前往来源站查看评论
            <ExternalLink className='h-4 w-4' />
          </a>
        )}
        <Link
          href={detailHref}
          className='inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-white/20 px-4 text-sm text-white/80 transition-colors hover:border-white/40 hover:text-white'
        >
          返回作品详情
        </Link>
      </div>
    </div>
  );

  useEffect(() => {
    if (!chapterListOpen) return;

    const rafId = window.requestAnimationFrame(() => {
      const scroller = chapterScrollerRef.current;
      const activeNode = activeChapterRef.current;
      if (!scroller || !activeNode) return;

      const viewport = scroller.clientHeight;
      const maxScrollTop = Math.max(scroller.scrollHeight - viewport, 0);
      const activeRect = activeNode.getBoundingClientRect();
      const activeTop =
        activeRect.top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      // 目前章節到清單尾端（含目前這一列）放得進一個 viewport 時直接對齊底部，
      // 否則最後幾話會被 center 推到看不見的位置；放不進才把目前章節置中。
      // 全程用 scroller 自己的 scrollTop，避免 scrollIntoView 連帶捲動 body。
      const tailFitsViewport = scroller.scrollHeight - activeTop <= viewport;
      const centeredTop = Math.max(
        activeTop - (viewport - activeRect.height) / 2,
        0
      );
      scroller.scrollTop = tailFitsViewport
        ? maxScrollTop
        : Math.min(centeredTop, maxScrollTop);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [chapterId, chapterListOpen, orderedChapterList]);

  const pagedItems = useMemo(() => {
    if (readMode === 'single') {
      return pages[activePage] ? [pages[activePage]] : [];
    }
    if (readMode === 'double') {
      return pages.slice(activePage, activePage + 2);
    }
    return [];
  }, [activePage, pages, readMode]);

  const imageClassName = useMemo(() => {
    if (scaleMode === 'original') {
      return 'block mx-auto h-auto w-auto max-w-none object-none';
    }
    if (readMode === 'single' || readMode === 'double') {
      return 'block h-auto w-full object-contain sm:mx-auto sm:max-h-[calc(100vh-8rem)] sm:w-auto sm:max-w-full';
    }
    return 'block h-auto w-full object-contain';
  }, [readMode, scaleMode]);

  const readerReady = pages.length > 0 && !historyRestorePending;
  const topControlsVisible = controlsVisible || !readerReady;

  const handleReaderClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, select, label')) return;
    if (settingsOpen || chapterListOpen || showChapterComplete) return;

    // 畫布點擊只切換 controls；翻頁統一由明確的底部按鈕處理。
    setControlsVisible((prev) => !prev);
  };

  return (
    <div
      className={
        immersiveMode
          ? 'relative min-h-[100dvh] w-full bg-black text-white'
          : 'mx-auto max-w-6xl'
      }
    >
      <button
        type='button'
        className='sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-sky-600 focus:px-4 focus:py-3 focus:text-sm focus:font-medium focus:text-white'
        onClick={() => setControlsVisible((prev) => !prev)}
        aria-pressed={controlsVisible}
      >
        {controlsVisible ? '隐藏' : '显示'}阅读控制
      </button>
      {settingsOpen && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4'
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className='w-full max-w-sm rounded-3xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-950'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='mb-4'>
              <div className='text-base font-semibold text-gray-900 dark:text-gray-100'>
                阅读设置
              </div>
              <div className='mt-1 text-xs text-gray-500'>
                可继续扩展更多阅读参数
              </div>
            </div>

            <div className='space-y-5'>
              <div>
                <div className='mb-2 text-sm font-medium text-gray-700 dark:text-gray-200'>
                  显示方式
                </div>
                <div className='grid grid-cols-2 gap-2'>
                  {READ_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type='button'
                      className={`rounded-2xl px-3 py-2 text-sm transition ${
                        readMode === option.value
                          ? 'bg-sky-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                      }`}
                      onClick={() => changeReadMode(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className='mb-2 text-sm font-medium text-gray-700 dark:text-gray-200'>
                  缩放类型
                </div>
                <div className='grid grid-cols-2 gap-2'>
                  {SCALE_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type='button'
                      className={`rounded-2xl px-3 py-2 text-sm transition ${
                        scaleMode === option.value
                          ? 'bg-sky-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                      }`}
                      onClick={() => setScaleMode(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className='mb-2 flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-200'>
                  <span>图片间隔</span>
                  <span>{pageGap}px</span>
                </div>
                <input
                  type='range'
                  min={0}
                  max={48}
                  step={4}
                  value={pageGap}
                  onChange={(event) => setPageGap(Number(event.target.value))}
                  className='w-full accent-sky-600'
                />
                <div className='mt-1 text-xs text-gray-500'>
                  滚动阅读时，两张图片之间的间隔
                </div>
              </div>

              <div className='flex justify-end'>
                <button
                  type='button'
                  className='rounded-2xl bg-sky-600 px-4 py-2 text-sm font-medium text-white'
                  onClick={() => setSettingsOpen(false)}
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {chapterListOpen && (
        <div
          className='fixed inset-0 z-40 bg-black/30'
          onClick={() => setChapterListOpen(false)}
        >
          <div
            ref={chapterScrollerRef}
            className='absolute right-0 top-[calc(3.5rem+env(safe-area-inset-top))] h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] w-full max-w-sm overflow-y-auto border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-950 sm:top-[calc(4rem+env(safe-area-inset-top))] sm:h-[calc(100dvh-4rem-env(safe-area-inset-top))]'
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className='p-4'
              style={{
                paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
              }}
            >
              <div className='mb-3 flex items-center justify-end'>
                <button
                  type='button'
                  className='inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900'
                  onClick={() => setChapterListDesc((prev) => !prev)}
                >
                  {chapterListDesc ? (
                    <ArrowDownWideNarrow className='h-4 w-4' />
                  ) : (
                    <ArrowUpWideNarrow className='h-4 w-4' />
                  )}
                  {chapterListDesc ? '倒序' : '正序'}
                </button>
              </div>
              {ownedMangaDetailLoading && (
                <div className='mb-3 rounded-2xl bg-gray-100 px-4 py-3 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300'>
                  正在载入章节列表…
                </div>
              )}
              {ownedMangaDetailError && (
                <div className='mb-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-300'>
                  无法载入章节列表：{ownedMangaDetailError}
                </div>
              )}
              <div className='space-y-2'>
                {orderedChapterList.map((chapter) => {
                  const active = chapter.id === chapterId;
                  return (
                    <Link
                      key={chapter.id}
                      ref={active ? activeChapterRef : null}
                      href={chapterReadHref(chapter)}
                      aria-current={active ? 'page' : undefined}
                      className={`group relative block rounded-2xl px-4 py-3 text-sm transition ${
                        active
                          ? 'bg-sky-600 text-white'
                          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-900'
                      }`}
                      onClick={(event) => {
                        setChapterListOpen(false);
                        if (!active) return;
                        // 即使 URL 已有 startPage=1、Next 不導航，明確再點目前
                        // 章節也要履行「從第 1 頁開始」。
                        event.preventDefault();
                        seekToPage(0, 'auto');
                      }}
                    >
                      <span className='block truncate'>{chapter.name}</span>
                      <div className='absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 dark:bg-gray-900 text-white text-sm rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 ease-out whitespace-nowrap z-[100] pointer-events-none'>
                        <div className='text-sm'>{chapter.name}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 沉浸模式把父層 header 收起，所以在閱讀器內提供必要的頂部操作。 */}
      {immersiveMode && topControlsVisible && (
        <div
          className='fixed inset-x-0 top-0 z-40'
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className='flex h-14 items-center gap-2 bg-black/75 px-3 text-white backdrop-blur-xl'>
            <Link
              href={detailHref}
              className='inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10'
              aria-label='返回作品详情'
            >
              <ChevronLeft className='h-5 w-5' />
            </Link>
            <div className='min-w-0 flex-1'>
              <div className='truncate text-sm font-semibold'>{title}</div>
              <div className='truncate text-xs text-white/60'>
                {chapterName}
              </div>
            </div>
            <button
              type='button'
              onClick={() => {
                setChapterListOpen(true);
                setControlsVisible(false);
              }}
              className='inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10'
              aria-label='章节列表'
            >
              <List className='h-5 w-5' />
            </button>
            <button
              type='button'
              onClick={() => {
                setSettingsOpen(true);
                setControlsVisible(false);
              }}
              className='inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10'
              aria-label='阅读设置'
            >
              <Settings2 className='h-5 w-5' />
            </button>
            <button
              type='button'
              onClick={toggleImmersiveMode}
              className='inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10'
              aria-label='退出阅读模式'
            >
              <Minimize2 className='h-5 w-5' />
            </button>
          </div>
        </div>
      )}

      {readerReady && controlsVisible && (
        <div
          className='fixed inset-x-0 bottom-0 z-40'
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className='flex items-center gap-2 border-t border-white/10 bg-black/80 px-3 py-3 text-white backdrop-blur-xl sm:px-5'>
            <button
              type='button'
              onClick={() => void toggleReaderShelf()}
              disabled={!ownedMangaDetail || !shelfLoaded || shelfSaving}
              className='inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20 disabled:opacity-40'
              aria-label={inShelf ? '移出书架' : '加入书架'}
            >
              {inShelf ? (
                <BookmarkCheck className='h-5 w-5' />
              ) : (
                <Bookmark className='h-5 w-5' />
              )}
            </button>
            <button
              type='button'
              onClick={reloadCurrentPage}
              className='inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20'
              aria-label='重新载入当前页'
              title='重新载入当前页'
            >
              <RefreshCw className='h-5 w-5' />
            </button>
            <button
              type='button'
              onClick={() => stepPage(-1)}
              disabled={readMode !== 'vertical' && activePage <= 0}
              className='inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20 disabled:opacity-30'
              aria-label='上一页'
            >
              <ChevronLeft className='h-5 w-5' />
            </button>
            <div className='min-w-0 flex-1'>
              <input
                type='range'
                min={0}
                max={Math.max(pages.length - 1, 0)}
                value={Math.min(displayedPage, Math.max(pages.length - 1, 0))}
                onChange={(event) =>
                  updateProgressDraft(Number(event.target.value))
                }
                onPointerUp={commitProgressDraft}
                onPointerCancel={cancelProgressDraft}
                onKeyUp={commitProgressDraft}
                onBlur={commitProgressDraft}
                className='h-2 w-full cursor-pointer accent-sky-500'
                aria-label='阅读进度'
                aria-valuetext={`第 ${Math.min(
                  displayedPage + 1,
                  pages.length
                )} 页，共 ${pages.length} 页`}
              />
              <div className='mt-1 flex justify-between text-[11px] text-white/60'>
                <span>
                  {Math.min(displayedPage + 1, pages.length)} / {pages.length}
                </span>
                <span>{progress}%</span>
              </div>
            </div>
            <button
              type='button'
              onClick={() => {
                if (!openChapterComplete()) stepPage(1);
              }}
              className='inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20'
              aria-label={isLastPageVisible ? '下一页或完成本话' : '下一页'}
            >
              <ChevronRight className='h-5 w-5' />
            </button>
          </div>
        </div>
      )}

      <div
        className={`relative select-none ${
          immersiveMode
            ? 'min-h-[100dvh] bg-black px-0 py-0'
            : 'min-h-[calc(100vh-5rem)] px-0 py-3 sm:px-3'
        }`}
        onClick={handleReaderClick}
      >
        {showChapterComplete && (
          <div
            className='fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4'
            onClick={() => setShowChapterComplete(false)}
          >
            <div
              className='w-full max-w-sm rounded-3xl border border-gray-200 bg-white p-6 text-center shadow-xl dark:border-gray-700 dark:bg-gray-950'
              onClick={(event) => event.stopPropagation()}
            >
              <div className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                {chapterName} 阅读完毕
              </div>
              <div className='mt-2 text-sm text-gray-500 dark:text-gray-400'>
                {ownedMangaDetailError
                  ? `无法确认下一话：${ownedMangaDetailError}`
                  : ownedMangaDetailLoading
                  ? '正在确认下一话…'
                  : nextChapter
                  ? '当前章节已读完，可继续阅读下一话'
                  : '当前章节已读完'}
              </div>
              <div className='mt-6 flex flex-col gap-3'>
                {!ownedMangaDetailError &&
                  !ownedMangaDetailLoading &&
                  nextChapter && (
                    <Link
                      href={chapterReadHref(nextChapter)}
                      className='rounded-2xl bg-sky-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-sky-700'
                    >
                      下一话：{nextChapter.name}
                    </Link>
                  )}
                {sourceCommentsUrl && (
                  <a
                    href={sourceCommentsUrl}
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center justify-center gap-2 rounded-2xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900'
                  >
                    前往来源站查看评论
                    <ExternalLink className='h-4 w-4' />
                  </a>
                )}
                <button
                  type='button'
                  className='rounded-2xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900'
                  onClick={() => setShowChapterComplete(false)}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {readerReady && !immersiveMode && !controlsVisible && (
          <div className='pointer-events-none fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/30 px-2 py-0.5 text-sm font-medium text-white/90 backdrop-blur-sm'>
            {Math.min(activePage + 1, pages.length)}/{pages.length}
          </div>
        )}

        {pagesError ? (
          <div className='px-4 py-16 text-center'>
            <p
              className={`text-sm ${
                immersiveMode
                  ? 'text-white/90'
                  : 'text-gray-700 dark:text-gray-200'
              }`}
            >
              {pagesError}
            </p>
            <Link
              href={detailHref}
              className='mt-4 inline-flex min-h-11 items-center rounded-2xl bg-sky-600 px-4 text-sm font-medium text-white transition-colors duration-200 hover:bg-sky-500'
            >
              返回作品详情
            </Link>
          </div>
        ) : pagesLoading || historyRestorePending ? (
          <MangaReadSkeleton readMode={readMode} pageGap={pageGap} />
        ) : null}

        {readerReady &&
          (readMode === 'vertical' ? (
            <div className='flex flex-col' style={{ gap: `${pageGap}px` }}>
              {pages.map((page, index) => (
                <div
                  key={`${page}-${index}`}
                  ref={(node) => {
                    verticalPageRefs.current[index] = node;
                  }}
                  data-index={index}
                  className='overflow-hidden bg-gray-100 shadow-sm dark:bg-gray-900'
                  style={{
                    minHeight: loadedVerticalPagesRef.current.has(index)
                      ? undefined
                      : '100dvh',
                  }}
                >
                  {(!verticalRestoreActive ||
                    loadedVerticalPagesRef.current.has(index) ||
                    shouldEagerLoadVerticalRestorePage(
                      index,
                      pendingVerticalRestorePageRef.current ?? -1,
                      PRELOAD_PAGE_COUNT
                    )) && (
                    <ProxyImage
                      key={getPageRenderKey(index)}
                      originalSrc={page}
                      displaySrc={getPageDisplaySrc(page, index)}
                      alt={`${chapterName}-${index + 1}`}
                      className={imageClassName}
                      loading={getImageLoadingStrategy(index)}
                      onLoad={() => handleVerticalImageSettled(index, true)}
                      onError={() => handleVerticalImageSettled(index, false)}
                    />
                  )}
                </div>
              ))}
              {chapterEndAction}
            </div>
          ) : readMode === 'horizontal' ? (
            <div
              ref={horizontalContainerRef}
              className='flex min-h-[calc(100vh-8rem)] snap-x snap-mandatory overflow-x-auto overflow-y-hidden scrollbar-hide'
              style={{ gap: `${pageGap}px` }}
            >
              {pages.map((page, index) => (
                <div
                  key={`${page}-${index}`}
                  className='flex min-w-full snap-center items-center justify-center px-1'
                >
                  <div className='w-full overflow-hidden bg-gray-100 shadow-sm dark:bg-gray-900'>
                    <ProxyImage
                      key={getPageRenderKey(index)}
                      originalSrc={page}
                      displaySrc={getPageDisplaySrc(page, index)}
                      alt={`${chapterName}-${index + 1}`}
                      className={imageClassName}
                      loading={getImageLoadingStrategy(index)}
                    />
                  </div>
                </div>
              ))}
              <div className='flex min-w-full snap-center items-center justify-center'>
                {chapterEndAction}
              </div>
            </div>
          ) : (
            <div className='flex min-h-[calc(100vh-8rem)] flex-col items-center justify-center'>
              <div
                className={`grid w-full max-w-6xl ${
                  readMode === 'double' ? 'md:grid-cols-2' : 'grid-cols-1'
                }`}
                style={{ gap: `${pageGap}px` }}
              >
                {pagedItems.map((page, index) => {
                  const pageIndex = activePage + index;
                  return (
                    <div
                      key={`${page}-${index}`}
                      className='overflow-hidden bg-gray-100 shadow-sm dark:bg-gray-900'
                    >
                      <ProxyImage
                        key={getPageRenderKey(pageIndex)}
                        originalSrc={page}
                        displaySrc={getPageDisplaySrc(page, pageIndex)}
                        alt={`${chapterName}-${pageIndex + 1}`}
                        className={imageClassName}
                        loading='eager'
                      />
                    </div>
                  );
                })}
                {readMode === 'double' && pagedItems.length === 1 && (
                  <div className='hidden rounded-[24px] bg-transparent md:block' />
                )}
              </div>
              {isLastPageVisible && (
                <div className='mt-6 w-full'>{chapterEndAction}</div>
              )}
            </div>
          ))}
      </div>

      <Link href={detailHref} className='sr-only'>
        返回详情
      </Link>
    </div>
  );
}
