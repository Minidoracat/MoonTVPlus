'use client';

import { BookOpen, Clock3 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  deleteMangaShelf,
  getAllMangaReadRecords,
  getAllMangaShelf,
  saveMangaShelf,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import {
  buildMangaReadHref,
  buildMangaShelfItem,
  isMangaChapterInProgress,
  orderMangaChapters,
  readMangaChapterNewestFirst,
} from '@/lib/manga-reader';
import {
  getMangaCreatorGroups,
  type MangaCreatorRole,
} from '@/lib/manga-search-view';
import { MangaChapter, MangaDetail, MangaReadRecord, MangaShelfItem } from '@/lib/manga.types';

import MangaChapterOrderToggle from '@/components/manga/MangaChapterOrderToggle';
import ProxyImage from '@/components/ProxyImage';

import MangaDetailSkeleton from './loading';

/** 章節一次畫這麼多：GoDa 有作品 3875 話，全畫在手機上會卡住一秒以上 */
const CHAPTER_BATCH = 120;

/** 頁數與更新日期各自有值就都顯示，不因有頁數就把日期丟掉 */
function formatChapterMeta(chapter: MangaChapter): string {
  const parts: string[] = [];
  if (typeof chapter.pageCount === 'number' && chapter.pageCount > 0) {
    parts.push(`${chapter.pageCount} 页`);
  }
  if (typeof chapter.uploadDate === 'number' && chapter.uploadDate > 0) {
    const timestamp =
      chapter.uploadDate > 1_000_000_000_000
        ? chapter.uploadDate
        : chapter.uploadDate * 1000;
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      parts.push(`更新于 ${date.toLocaleDateString('zh-CN')}`);
    }
  }
  return parts.join(' · ');
}

function creatorSearchHref(
  sourceId: string,
  creator: string,
  role: MangaCreatorRole
): string {
  const params = new URLSearchParams({
    q: creator,
    sourceId,
    creator,
    creatorRole: role,
  });
  return `/manga/search?${params.toString()}`;
}

export default function MangaDetailPage() {
  const searchParams = useSearchParams();
  const mangaId = searchParams.get('mangaId') || '';
  const sourceId = searchParams.get('sourceId') || '';
  const returnTo = searchParams.get('returnTo') || '/manga';
  const [detail, setDetail] = useState<MangaDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [history, setHistory] = useState<Record<string, MangaReadRecord>>({});
  const [shelf, setShelf] = useState<Record<string, MangaShelfItem>>({});
  // 預設最早在前（從第一話往下看）；使用者改過就記住，閱讀器的章節面板也沿用
  const [descOrder, setDescOrder] = useState(false);
  const [chapterLimit, setChapterLimit] = useState(CHAPTER_BATCH);
  const clearedOnOpenRef = useRef<string | null>(null);

  const key = `${sourceId}+${mangaId}`;
  const currentRecord = history[key];

  useEffect(() => {
    if (!mangaId || !sourceId) return;

    const params = new URLSearchParams({
      mangaId,
      sourceId,
      title: searchParams.get('title') || '',
      cover: searchParams.get('cover') || '',
      sourceName: searchParams.get('sourceName') || '',
      description: searchParams.get('description') || '',
      author: searchParams.get('author') || '',
      status: searchParams.get('status') || '',
    });

    setDetailError('');
    fetch(`/api/manga/detail?${params.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        // 403（來源被管理員停用）或其他錯誤不可當成 MangaDetail 塞進 state，
        // 否則會顯示一個沒有章節、沒有標題的壞頁面。書架裡的舊項目就會走到這。
        if (!res.ok) {
          throw new Error(data?.error || '无法载入漫画详情');
        }
        setDetail(data);
      })
      .catch((err) => {
        setDetail(null);
        setDetailError(
          err instanceof Error ? err.message : '无法载入漫画详情'
        );
      });

    getAllMangaReadRecords().then(setHistory).catch(() => undefined);
    getAllMangaShelf().then(setShelf).catch(() => undefined);
  }, [mangaId, searchParams, sourceId]);

  // 訂閱 history 讓「继续阅读」第一次進頁就出現（快取先回舊快照、背景抓完才廣播）。
  // 不訂閱 shelf：下方清零 effect 會廣播 unread=0，一訂閱就把本頁要保留的 NEW 抹掉。
  useEffect(
    () =>
      subscribeToDataUpdates<Record<string, MangaReadRecord>>(
        'mangaHistoryUpdated',
        setHistory
      ),
    []
  );

  useEffect(() => {
    setDescOrder(readMangaChapterNewestFirst());
  }, []);

  // 換作品就從頭只畫一批
  useEffect(() => {
    setChapterLimit(CHAPTER_BATCH);
  }, [key]);

  const chronologicalChapters = useMemo(
    () => orderMangaChapters(detail?.chapters || []),
    [detail?.chapters]
  );

  const chapters = useMemo(
    () => descOrder ? [...chronologicalChapters].reverse() : chronologicalChapters,
    [chronologicalChapters, descOrder]
  );

  // 「开始阅读」永遠指向第一話；不能拿 chapters[0]，倒序時那是最新一話
  const firstChapter = chronologicalChapters[0];
  const latestChapter = chronologicalChapters[chronologicalChapters.length - 1];
  const unreadChapterCount = shelf[key]?.unreadChapterCount || 0;
  const newChapterIds = useMemo(() => {
    if (unreadChapterCount <= 0) return new Set<string>();
    return new Set(chronologicalChapters.slice(-unreadChapterCount).map((chapter) => chapter.id));
  }, [chronologicalChapters, unreadChapterCount]);

  useEffect(() => {
    const shelfItem = shelf[key];
    if (!detail || !shelfItem || !latestChapter || (shelfItem.unreadChapterCount || 0) <= 0) {
      return;
    }

    if (clearedOnOpenRef.current === key) {
      return;
    }
    clearedOnOpenRef.current = key;

    const nextItem: MangaShelfItem = {
      ...shelfItem,
      latestChapterId: latestChapter.id,
      latestChapterName: latestChapter.name,
      latestChapterCount: chronologicalChapters.length,
      unreadChapterCount: 0,
    };

    // 只后台清零，当前页保留进入时看到的更新提示，刷新后再消失。
    saveMangaShelf(sourceId, mangaId, nextItem).catch((err) => {
      clearedOnOpenRef.current = null;
      console.error('清除未读标记失败', err);
    });
  }, [chronologicalChapters.length, detail, key, latestChapter, mangaId, shelf, sourceId]);

  const toggleShelf = async () => {
    if (!detail) return;
    if (shelf[key]) {
      await deleteMangaShelf(sourceId, mangaId);
      setShelf((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    const item = buildMangaShelfItem({
      detail,
      currentChapter: currentRecord
        ? {
            id: currentRecord.chapterId,
            name: currentRecord.chapterName,
          }
        : undefined,
    });
    await saveMangaShelf(sourceId, mangaId, item);
    setShelf((prev) => ({ ...prev, [key]: item }));
  };

  // 讀到一半的那一話（列表上寫著「上次看到第 N 页」）點下去接著讀；其他話從第 1 頁
  const chapterHref = (
    chapter: MangaChapter,
    startAt: 'first' | 'resume' = isMangaChapterInProgress(currentRecord, chapter.id)
      ? 'resume'
      : 'first'
  ) =>
    buildMangaReadHref({
      mangaId,
      sourceId,
      chapterId: chapter.id,
      title: detail?.title || '',
      cover: detail?.cover || '',
      sourceName: detail?.sourceName || '',
      chapterName: chapter.name,
      returnTo,
      startAt,
    });

  if (detailError) {
    return (
      <div className='mx-auto max-w-2xl px-4 py-16 text-center'>
        <p className='text-sm text-gray-700 dark:text-gray-200'>{detailError}</p>
        <Link
          href={returnTo}
          className='mt-4 inline-flex min-h-11 items-center rounded-2xl bg-sky-600 px-4 text-sm font-medium text-white transition-colors duration-200 hover:bg-sky-500'
        >
          返回
        </Link>
      </div>
    );
  }

  if (!detail) return <MangaDetailSkeleton />;

  const creatorGroups = getMangaCreatorGroups(detail);


  return (
    <div className='space-y-6'>
      {/* 手機封面縮成左欄，讓標題與「开始阅读」進首屏；md 起封面撐滿兩列高度 */}
      <div className='grid grid-cols-[112px_1fr] gap-4 rounded-[28px] border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950 sm:p-6 md:grid-cols-[260px_1fr] md:gap-6'>
        <div className='aspect-[3/4] self-start overflow-hidden rounded-2xl bg-gray-100 dark:bg-gray-800 md:row-span-2 md:aspect-auto md:self-stretch md:rounded-3xl'>
          {detail.cover ? (
            // 標題就在旁邊的 h1，封面不再重唸一次
            <ProxyImage originalSrc={detail.cover} alt='' className='h-full w-full object-cover' />
          ) : (
            <div className='flex h-full items-center justify-center text-sm text-gray-400'>暂无封面</div>
          )}
        </div>
        <div className='min-w-0'>
          <h1 className='break-words text-2xl font-bold md:text-3xl'>
            {detail.title}
          </h1>
          <div className='mt-3 flex flex-wrap gap-2 text-xs text-gray-500'>
            <span className='rounded-full bg-sky-50 px-3 py-1 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'>
              {detail.sourceName}
            </span>
            {detail.status && (
              <span className='rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800'>
                {detail.status}
              </span>
            )}
          </div>
          {creatorGroups.map((group) => (
            <div
              key={group.role}
              className='mt-3 flex flex-wrap items-center gap-2 text-xs'
            >
              <span className='text-gray-500 dark:text-gray-400'>
                {group.label}
              </span>
              {group.creators.map((creator) => (
                <Link
                  key={creator.toLowerCase()}
                  href={creatorSearchHref(sourceId, creator, group.role)}
                  title={`搜索 ${creator} 在 ${detail.sourceName} 的全部${group.label}作品`}
                  className='inline-flex min-h-9 max-w-full items-center truncate rounded-full border border-gray-200 px-3 text-sky-700 transition-colors hover:border-sky-500 hover:bg-sky-50 dark:border-gray-700 dark:text-sky-300 dark:hover:border-sky-500 dark:hover:bg-sky-950/40'
                >
                  {creator}
                </Link>
              ))}
            </div>
          ))}
        </div>
        <div className='col-span-full space-y-4 md:col-span-1 md:col-start-2'>
          {detail.description && <p className='text-sm leading-7 text-gray-600 dark:text-gray-300'>{detail.description}</p>}
          <div className='flex flex-wrap gap-3'>
            {/* 有閱讀紀錄時「继续阅读」是主要動作：從書架、推荐點回作品，一按就回到上次那一頁 */}
            {currentRecord && (
              <Link
                href={buildMangaReadHref({
                  mangaId,
                  sourceId,
                  chapterId: currentRecord.chapterId,
                  title: detail.title,
                  cover: detail.cover,
                  sourceName: detail.sourceName,
                  chapterName: currentRecord.chapterName,
                  returnTo,
                  startAt: 'resume',
                })}
                className='inline-flex min-h-11 grow items-center justify-center rounded-2xl bg-sky-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-sky-700 sm:grow-0'
              >
                <Clock3 aria-hidden='true' className='mr-2 h-4 w-4 shrink-0' />
                <span className='min-w-0 text-left'>
                  <span className='block'>继续阅读</span>
                  <span className='block break-words text-xs font-normal opacity-80'>
                    {currentRecord.chapterName} · 第 {currentRecord.pageIndex + 1}/{currentRecord.pageCount} 页
                  </span>
                </span>
              </Link>
            )}
            {firstChapter && (
              <Link
                href={chapterHref(firstChapter, 'first')}
                className={`inline-flex min-h-11 grow items-center justify-center rounded-2xl px-5 py-3 text-sm font-medium transition sm:grow-0 ${
                  currentRecord
                    ? 'border border-sky-300 text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950/30'
                    : 'bg-sky-600 text-white hover:bg-sky-700'
                }`}
              >
                <BookOpen aria-hidden='true' className='mr-2 inline h-4 w-4' />
                {currentRecord ? '从第一话开始' : '开始阅读'}
              </Link>
            )}
            <button type='button' onClick={toggleShelf} className='inline-flex min-h-11 grow items-center justify-center rounded-2xl border border-gray-200 px-5 py-3 text-sm font-medium text-gray-700 transition hover:border-sky-300 hover:text-sky-600 dark:border-gray-700 dark:text-gray-200 sm:grow-0'>
              {shelf[key] ? '移出书架' : '加入书架'}
            </button>
          </div>
        </div>
      </div>

      <div className='rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950'>
        <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
          <h2 className='text-lg font-semibold'>
            章节列表
            <span className='ml-2 text-sm font-normal text-gray-500 dark:text-gray-400'>
              共 {chronologicalChapters.length} 话
            </span>
          </h2>
          {chronologicalChapters.length > 1 && (
            <MangaChapterOrderToggle newestFirst={descOrder} onChange={setDescOrder} />
          )}
        </div>
        {unreadChapterCount > 0 && latestChapter && (
          <div className='mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300'>
            新增 {unreadChapterCount} 话，最新章节：{latestChapter.name}
          </div>
        )}
        {chronologicalChapters.length === 0 && (
          <p className='rounded-2xl bg-gray-50 px-4 py-8 text-center text-sm text-gray-500 dark:bg-gray-900/50 dark:text-gray-400'>
            暂无章节
          </p>
        )}
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
          {chapters.slice(0, chapterLimit).map((chapter) => {
            const active = currentRecord?.chapterId === chapter.id;
            const isNewChapter = newChapterIds.has(chapter.id);
            const metaText = [
              formatChapterMeta(chapter),
              active && currentRecord ? `上次看到第 ${currentRecord.pageIndex + 1} 页` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <Link
                key={chapter.id}
                href={chapterHref(chapter)}
                prefetch={false}
                aria-current={active ? 'true' : undefined}
                // 觸控點過後 :hover 會殘留，藍框容易被看成「目前章節」，hover 只給真的能 hover 的裝置
                className={`rounded-2xl border px-4 py-3 text-sm transition ${active ? 'border-sky-400 bg-sky-50 dark:bg-sky-950/30' : isNewChapter ? 'border-emerald-300 bg-emerald-50/80 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-gray-200 dark:border-gray-700 [@media(hover:hover)]:hover:border-sky-300'}`}
              >
                <div className='flex items-center justify-between gap-3'>
                  <div className='break-words font-medium text-gray-900 dark:text-gray-100'>{chapter.name}</div>
                  {isNewChapter && (
                    <span className='rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300'>
                      新增
                    </span>
                  )}
                </div>
                {metaText && <div className='mt-1 text-xs text-gray-500'>{metaText}</div>}
              </Link>
            );
          })}
        </div>
        {chapters.length > chapterLimit && (
          <button
            type='button'
            onClick={() => setChapterLimit((limit) => limit + CHAPTER_BATCH * 2)}
            className='mt-4 inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-2xl border border-gray-200 px-4 text-sm font-medium text-gray-700 transition-colors hover:border-sky-300 hover:text-sky-600 dark:border-gray-700 dark:text-gray-200'
          >
            再显示 {Math.min(CHAPTER_BATCH * 2, chapters.length - chapterLimit)} 话（还有 {chapters.length - chapterLimit} 话）
          </button>
        )}
      </div>
    </div>
  );
}
