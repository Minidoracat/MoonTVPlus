'use client';

import { Building2, ChevronDown, Clock3, Layers, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  filterMangaSources,
  getMangaSourceCategories,
  getMangaSourceCategory,
  getMangaSourceLabel,
  readRecentMangaSourceIds,
  rememberMangaSourceId,
  sourcesInCategory,
  type MangaSourceCategoryId,
} from '@/lib/manga-source-groups';
import type { MangaSource } from '@/lib/manga.types';

import MangaSourceSheet from '@/components/manga/MangaSourceSheet';

interface MangaSourcePickerProps {
  sources: MangaSource[];
  value: string;
  onChange: (sourceId: string) => void;
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
}

const CATEGORY_ICON: Record<
  Exclude<MangaSourceCategoryId, 'all'>,
  typeof Layers
> = {
  recent: Clock3,
  safe: Layers,
  mixed: Building2,
  adult: ShieldAlert,
};

export default function MangaSourcePicker({
  sources,
  value,
  onChange,
  allowAll = false,
  allLabel = '全部来源',
  className = '',
}: MangaSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MangaSourceCategoryId>('all');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setRecentIds(readRecentMangaSourceIds());
  }, []);

  const closePicker = () => {
    setOpen(false);
    setQuery('');
    setCategory('all');
  };

  const selected = sources.find((source) => source.id === value);
  const triggerLabel = value
    ? selected
      ? getMangaSourceLabel(selected)
      : value
    : allowAll
      ? allLabel
      : '请选择漫画源';

  const categories = useMemo(
    () => getMangaSourceCategories(sources, recentIds),
    [recentIds, sources]
  );

  const visibleSources = useMemo(() => {
    const byCategory = sourcesInCategory(sources, category, recentIds);
    return filterMangaSources(byCategory, query);
  }, [category, query, recentIds, sources]);

  const selectSource = (sourceId: string) => {
    if (sourceId) {
      setRecentIds(rememberMangaSourceId(sourceId));
    }
    onChange(sourceId);
    closePicker();
  };

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type='button'
        aria-haspopup='dialog'
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className='flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-2 text-left transition-colors duration-200 hover:border-sky-400 dark:border-gray-800 dark:bg-gray-950'
      >
        <span className='min-w-0'>
          <span className='block truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
            {triggerLabel}
          </span>
          <span className='block text-xs text-gray-500 dark:text-gray-400'>
            {sources.length} 个源 · 点按搜索或分类
          </span>
        </span>
        <ChevronDown className='h-4 w-4 shrink-0 text-gray-400' />
      </button>

      <MangaSourceSheet
        open={open}
        onClose={closePicker}
        title='选择漫画源'
        subtitle={`${sources.length} 个可用源，可搜索或按分类筛选`}
        query={query}
        onQueryChange={setQuery}
        searchInputId='manga-source-search'
        categories={categories}
        activeCategory={category}
        onCategoryChange={setCategory}
        triggerRef={triggerRef}
      >
        <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
          {allowAll && category === 'all' && query.trim().length === 0 && (
            <button
              type='button'
              onClick={() => selectSource('')}
              className={`min-h-11 cursor-pointer rounded-2xl border px-3 py-2 text-left text-sm transition-colors duration-200 ${
                value === ''
                  ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                  : 'border-gray-200 text-gray-700 hover:border-sky-400 dark:border-gray-800 dark:text-gray-200'
              }`}
            >
              {allLabel}
            </button>
          )}
          {visibleSources.map((source) => {
            const Icon = CATEGORY_ICON[getMangaSourceCategory(source)];
            const active = source.id === value;
            return (
              <button
                key={source.id}
                type='button'
                onClick={() => selectSource(source.id)}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-colors duration-200 ${
                  active
                    ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                    : 'border-gray-200 text-gray-700 hover:border-sky-400 dark:border-gray-800 dark:text-gray-200'
                }`}
              >
                <Icon className='h-4 w-4 shrink-0 opacity-70' />
                <span className='truncate text-sm font-medium'>
                  {getMangaSourceLabel(source)}
                </span>
              </button>
            );
          })}
        </div>
        {visibleSources.length === 0 && (
          <div className='rounded-2xl bg-gray-50 px-4 py-8 text-center text-sm text-gray-500 dark:bg-gray-900/60 dark:text-gray-400'>
            没有匹配的漫画源，试试其他关键词或分类
          </div>
        )}
      </MangaSourceSheet>
    </div>
  );
}
