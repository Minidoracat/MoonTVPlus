'use client';

import { BookOpen, Search, Star } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import {
  deleteMangaShelf,
  getAllMangaShelf,
  saveMangaShelf,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { MangaShelfItem } from '@/lib/manga.types';
import { buildMangaAlternateSearchHref } from '@/lib/manga-reader';
import {
  selectShelfEntries,
  SHELF_TABS,
  shelfSubtitle,
  ShelfTab,
} from '@/lib/manga-shelf';

import MangaCard from '@/components/MangaCard';

function MangaShelfSkeleton() {
  return (
    <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className='space-y-2'>
          <div className='overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950'>
            <div className='aspect-[3/4] w-full animate-pulse bg-gray-200 dark:bg-gray-800' />
            <div className='space-y-3 p-3'>
              <div className='h-4 w-3/4 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
              <div className='h-3 w-1/2 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
            </div>
          </div>
          <div className='h-9 w-full animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800' />
        </div>
      ))}
    </div>
  );
}

export default function MangaShelfPage() {
  const [shelf, setShelf] = useState<Record<string, MangaShelfItem>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ShelfTab>('all');

  useEffect(() => {
    const unsubscribe = subscribeToDataUpdates<Record<string, MangaShelfItem>>(
      'mangaShelfUpdated',
      setShelf
    );

    getAllMangaShelf()
      .then(setShelf)
      .catch(() => undefined)
      .finally(() => setLoading(false));

    return unsubscribe;
  }, []);

  const shelfList = useMemo(
    () => selectShelfEntries(shelf, tab),
    [shelf, tab]
  );

  const removeItem = async (sourceId: string, mangaId: string) => {
    const key = `${sourceId}+${mangaId}`;
    await deleteMangaShelf(sourceId, mangaId);
    setShelf((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // ponytail: 整包 upsert，與 cron 同時寫入時 last-write-wins；若實際出現丟標記再改 field-level PATCH
  const toggleFavorite = (item: MangaShelfItem) => {
    const key = `${item.sourceId}+${item.mangaId}`;
    const nextItem: MangaShelfItem = { ...item, favorite: !item.favorite };
    setShelf((prev) => ({ ...prev, [key]: nextItem }));
    // db.client 已顯示錯誤並用伺服器狀態回復 optimistic cache。
    saveMangaShelf(item.sourceId, item.mangaId, nextItem).catch(() => undefined);
  };

  return (
    <section className='mx-auto max-w-6xl'>
      <div className='mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-gray-500'>
        <span className='inline-flex items-center gap-2'>
          <BookOpen className='h-4 w-4 text-emerald-500' /> 共{' '}
          {shelfList.length} 本漫画
        </span>
        <div className='flex flex-wrap gap-1.5'>
          {SHELF_TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                tab === key
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <MangaShelfSkeleton />
      ) : shelfList.length === 0 ? (
        <div className='rounded-2xl bg-gray-50 p-10 text-center text-sm text-gray-500 dark:bg-gray-900/50'>
          {Object.keys(shelf).length === 0 ? '暂无书架内容' : '该分类暂无漫画'}
        </div>
      ) : (
        <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
          {shelfList.map(([key, item]) => (
            <div key={key} className='relative flex h-full flex-col gap-2'>
              <button
                onClick={() => toggleFavorite(item)}
                aria-label={item.favorite ? '取消最爱' : '加入最爱'}
                className='absolute left-2 top-2 z-30 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white'
              >
                <Star
                  className={`h-4 w-4 ${
                    item.favorite ? 'fill-current text-amber-400' : ''
                  }`}
                />
              </button>
              <MangaCard
                className='flex-1'
                item={item}
                href={`/manga/detail?mangaId=${item.mangaId}&sourceId=${
                  item.sourceId
                }&title=${encodeURIComponent(
                  item.title
                )}&cover=${encodeURIComponent(
                  item.cover
                )}&sourceName=${encodeURIComponent(item.sourceName)}`}
                subtitle={shelfSubtitle(item)}
                updateCount={item.unreadChapterCount}
              />
              <div className='mt-auto grid grid-cols-2 gap-2'>
                <Link
                  href={buildMangaAlternateSearchHref(item.title)}
                  className='inline-flex h-9 items-center justify-center gap-1 whitespace-nowrap rounded-2xl border border-gray-200 px-2 text-xs font-medium text-sky-700 transition hover:border-sky-400 dark:border-gray-700 dark:text-sky-300'
                >
                  <Search className='h-3.5 w-3.5 shrink-0' />
                  换源
                </Link>
                <button
                  onClick={() => removeItem(item.sourceId, item.mangaId)}
                  className='inline-flex h-9 items-center justify-center whitespace-nowrap rounded-2xl border border-gray-200 px-2 text-xs font-medium text-gray-700 transition hover:border-red-300 hover:text-red-600 dark:border-gray-700 dark:text-gray-200'
                >
                  移出书架
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
