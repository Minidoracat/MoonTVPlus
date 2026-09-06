'use client';

import {
  BookOpen,
  ChevronLeft,
  Compass,
  History,
  List,
  Maximize2,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { LanguageToggle } from '@/components/LanguageToggle';
import MangaSourceManagerPanel from '@/components/manga/MangaSourceManagerPanel';
import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UpdateNotification } from '@/components/UpdateNotification';
import { UserMenu } from '@/components/UserMenu';
import { getAuthInfoFromBrowserCookie } from '@/lib/auth';

interface MangaLayoutProps {
  children: React.ReactNode;
}

const sectionTabs = [
  { href: '/manga', label: '推荐', icon: Compass },
  { href: '/manga/search', label: '搜索', icon: Search },
  { href: '/manga/shelf', label: '书架', icon: BookOpen },
  { href: '/manga/history', label: '历史', icon: History },
];

/** 閱讀頁的頂部操作；實際行為由 /manga/read 監聽同名事件實作。 */
const readerActions = [
  { event: 'manga-read-toggle-immersive', label: '阅读模式', icon: Maximize2 },
  { event: 'manga-read-toggle-chapters', label: '章节列表', icon: List },
  { event: 'manga-read-toggle-settings', label: '阅读设置', icon: Settings2 },
];

function getMeta(
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>
) {
  if (pathname === '/manga/shelf') {
    return { title: '漫画书架', subtitle: '集中管理收藏的漫画' };
  }
  if (pathname === '/manga/history') {
    return { title: '漫画历史', subtitle: '从上次阅读的位置继续' };
  }
  if (pathname === '/manga/search') {
    return { title: '漫画搜索', subtitle: '按标题和来源搜索漫画' };
  }
  if (pathname === '/manga/detail') {
    return {
      title: searchParams.get('title') || '漫画详情',
      subtitle: searchParams.get('sourceName') || '漫画详情',
      backHref: searchParams.get('returnTo') || '/manga',
    };
  }
  if (pathname === '/manga/read') {
    const mangaId = searchParams.get('mangaId') || '';
    const sourceId = searchParams.get('sourceId') || '';
    const title = searchParams.get('title') || '漫画阅读';
    const cover = searchParams.get('cover') || '';
    const sourceName = searchParams.get('sourceName') || sourceId;
    const returnTo = searchParams.get('returnTo') || '/manga';
    return {
      title,
      subtitle: searchParams.get('chapterName') || '章节',
      backHref: `/manga/detail?mangaId=${encodeURIComponent(
        mangaId
      )}&sourceId=${encodeURIComponent(sourceId)}&title=${encodeURIComponent(
        title
      )}&cover=${encodeURIComponent(cover)}&sourceName=${encodeURIComponent(
        sourceName
      )}&returnTo=${encodeURIComponent(returnTo)}`,
    };
  }
  return { title: '漫画推荐', subtitle: '按来源查看热门与最新漫画' };
}

export default function MangaLayout({ children }: MangaLayoutProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { siteName } = useSite();
  const meta = getMeta(pathname, searchParams);
  const isReadingPage = pathname === '/manga/read';

  // 管理員入口：一般使用者完全看不到這顆按鈕，後端 API 也另有權限檢查
  const [isAdmin, setIsAdmin] = useState(false);
  const [showSourceManager, setShowSourceManager] = useState(false);
  const [readerImmersive, setReaderImmersive] = useState(false);
  const [readerControlsVisible, setReaderControlsVisible] = useState(true);
  // 觸發按鈕桌面在 header、手機在底部 nav，各自一顆；記住實際開啟者，關閉時焦點才回得去。
  // 要在點擊當下記，dialog 的 autoFocus 在 effect 跑之前就已把焦點移走。
  const openerRef = useRef<HTMLElement | null>(null);
  const openSourceManager = (event: React.MouseEvent<HTMLElement>) => {
    openerRef.current = event.currentTarget;
    setShowSourceManager(true);
  };

  useEffect(() => {
    const auth = getAuthInfoFromBrowserCookie();
    setIsAdmin(auth?.role === 'owner' || auth?.role === 'admin');
  }, []);

  useEffect(() => {
    if (!showSourceManager) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowSourceManager(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKeyDown);
      openerRef.current?.focus({ preventScroll: true });
    };
  }, [showSourceManager]);

  useEffect(() => {
    if (!isReadingPage) {
      setReaderImmersive(false);
      setReaderControlsVisible(true);
      return undefined;
    }
    const handleImmersiveChange = (event: Event) => {
      setReaderImmersive(Boolean((event as CustomEvent<boolean>).detail));
    };
    const handleControlsChange = (event: Event) => {
      setReaderControlsVisible(Boolean((event as CustomEvent<boolean>).detail));
    };
    window.addEventListener(
      'manga-read-immersive-change',
      handleImmersiveChange
    );
    window.addEventListener('manga-read-controls-change', handleControlsChange);
    return () => {
      window.removeEventListener(
        'manga-read-immersive-change',
        handleImmersiveChange
      );
      window.removeEventListener(
        'manga-read-controls-change',
        handleControlsChange
      );
    };
  }, [isReadingPage]);

  const isActive = (href: string) => pathname === href;

  return (
    <div
      className={`min-h-dvh ${
        isReadingPage || readerImmersive ? '' : 'touch-manipulation'
      } ${
        readerImmersive
          ? 'bg-black text-white'
          : 'bg-gray-50 text-gray-900 dark:bg-black dark:text-gray-100'
      }`}
    >
      {!readerImmersive && (!isReadingPage || readerControlsVisible) && (
        <header
          className='fixed inset-x-0 top-0 z-[999] border-b border-gray-200/70 bg-white/85 shadow-sm backdrop-blur-xl dark:border-gray-800/80 dark:bg-gray-950/85'
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className='mx-auto flex h-14 max-w-7xl items-center gap-3 px-3 sm:h-16 sm:px-6'>
            <div className='flex min-w-0 flex-1 items-center gap-2'>
              {meta.backHref ? (
                <Link
                  href={meta.backHref}
                  className='flex h-10 w-10 items-center justify-center rounded-full text-gray-600 transition hover:bg-gray-100 hover:text-sky-600 dark:text-gray-300 dark:hover:bg-gray-800'
                >
                  <ChevronLeft className='h-5 w-5' />
                </Link>
              ) : (
                <Link
                  href='/'
                  className='flex h-10 items-center rounded-full px-3 text-sm font-semibold text-sky-600 transition hover:bg-sky-50 dark:hover:bg-sky-950/40'
                >
                  {siteName}
                </Link>
              )}
              <div className='min-w-0'>
                <div className='group relative'>
                  <div className='truncate text-sm font-semibold sm:text-base'>
                    {meta.title}
                  </div>
                  <div className='absolute top-full left-1/2 transform -translate-x-1/2 mt-2 px-3 py-2 bg-gray-800 dark:bg-gray-900 text-white text-sm rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 ease-out z-[100] pointer-events-none w-max max-w-[85vw] whitespace-normal break-words text-center sm:max-w-none sm:whitespace-nowrap'>
                    <div className='text-sm'>{meta.title}</div>
                  </div>
                </div>
                {meta.subtitle && (
                  <div className='truncate text-xs text-gray-500 dark:text-gray-400'>
                    {meta.subtitle}
                  </div>
                )}
              </div>
            </div>

            <nav className='ml-auto hidden items-center gap-2 lg:flex'>
              {sectionTabs.map((tab) => {
                const Icon = tab.icon;
                const active = isActive(tab.href);
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition ${
                      active
                        ? 'bg-sky-600 text-white shadow-sm'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-sky-600 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    <Icon className='h-4 w-4' />
                    {tab.label}
                  </Link>
                );
              })}
              {isAdmin && !isReadingPage && (
                <button
                  type='button'
                  onClick={openSourceManager}
                  aria-haspopup='dialog'
                  aria-expanded={showSourceManager}
                  className='inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-100 hover:text-sky-600 dark:text-gray-300 dark:hover:bg-gray-800'
                >
                  <SlidersHorizontal className='h-4 w-4' />
                  源管理
                </button>
              )}
            </nav>

            {/* 手機也留主題／使用者／更新入口，與影視區 MobileHeader 一致；語言切換只在 md+ */}
            <div className='ml-auto flex shrink-0 items-center gap-2'>
              {isReadingPage ? (
                readerActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.event}
                      type='button'
                      className='inline-flex h-10 w-10 items-center justify-center rounded-full text-gray-600 transition hover:bg-gray-100 hover:text-sky-600 dark:text-gray-300 dark:hover:bg-gray-800'
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent(action.event));
                      }}
                      aria-label={action.label}
                    >
                      <Icon className='h-5 w-5' />
                    </button>
                  );
                })
              ) : (
                <>
                  <span className='hidden md:inline-flex'>
                    <LanguageToggle />
                  </span>
                  <ThemeToggle />
                  <UserMenu />
                  <UpdateNotification />
                </>
              )}
            </div>
          </div>
        </header>
      )}

      <main
        className={
          readerImmersive
            ? 'min-h-[100dvh] max-w-none p-0'
            : isReadingPage
            ? 'mx-auto max-w-7xl px-0 pt-[calc(5rem+env(safe-area-inset-top))] pb-24 sm:px-0 sm:pt-[calc(6rem+env(safe-area-inset-top))] sm:pb-28 lg:pb-10'
            : 'mx-auto max-w-7xl px-3 pt-[calc(5rem+env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-[calc(6rem+env(safe-area-inset-top))] sm:pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-10'
        }
      >
        {children}
      </main>

      {!isReadingPage && (
        <nav
          className='fixed inset-x-0 bottom-0 z-[998] border-t border-gray-200/70 bg-white/92 backdrop-blur-xl dark:border-gray-800/80 dark:bg-gray-950/92 lg:hidden'
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div
            className={`mx-auto grid max-w-3xl ${
              isAdmin ? 'grid-cols-5' : 'grid-cols-4'
            }`}
          >
            {sectionTabs.map((tab) => {
              const Icon = tab.icon;
              const active = isActive(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className='flex min-h-16 flex-col items-center justify-center gap-1 py-2 text-xs'
                >
                  <Icon
                    className={`h-5 w-5 ${
                      active
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-gray-500 dark:text-gray-400'
                    }`}
                  />
                  <span
                    className={
                      active
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-gray-600 dark:text-gray-300'
                    }
                  >
                    {tab.label}
                  </span>
                </Link>
              );
            })}
            {isAdmin && (
              <button
                type='button'
                onClick={openSourceManager}
                aria-haspopup='dialog'
                aria-expanded={showSourceManager}
                className='flex min-h-16 cursor-pointer flex-col items-center justify-center gap-1 py-2 text-xs'
              >
                <SlidersHorizontal className='h-5 w-5 text-gray-500 dark:text-gray-400' />
                <span className='text-gray-600 dark:text-gray-300'>源管理</span>
              </button>
            )}
          </div>
        </nav>
      )}

      {showSourceManager &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className='fixed inset-0 z-[1000] flex items-end justify-center sm:items-center sm:p-4'>
            <button
              type='button'
              aria-label='关闭源管理'
              tabIndex={-1}
              onClick={() => setShowSourceManager(false)}
              className='absolute inset-0 bg-black/50'
            />
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='manga-source-manager-title'
              className='relative flex max-h-[88dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl border border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-xl dark:border-gray-800 dark:bg-gray-950 sm:max-h-[85vh] sm:rounded-3xl sm:pb-0'
            >
              <div className='flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800'>
                <h2
                  id='manga-source-manager-title'
                  className='text-sm font-semibold text-gray-900 dark:text-gray-100'
                >
                  漫画源管理
                </h2>
                <button
                  type='button'
                  autoFocus
                  onClick={() => setShowSourceManager(false)}
                  aria-label='关闭'
                  className='inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-2xl text-gray-500 transition-colors duration-200 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-900 dark:hover:text-gray-100'
                >
                  <X className='h-5 w-5' />
                </button>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto px-4 py-4'>
                <MangaSourceManagerPanel showHeading={false} />
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
