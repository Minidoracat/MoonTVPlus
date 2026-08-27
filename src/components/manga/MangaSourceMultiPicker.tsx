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
import {
  formatMangaSourceHealth,
  type MangaSourceHealth,
} from '@/lib/manga-source-health';
import type { MangaSource } from '@/lib/manga.types';

import MangaSourceSheet from '@/components/manga/MangaSourceSheet';

interface MangaSourceMultiPickerProps {
  sources: MangaSource[];
  value: string[];
  onChange: (sourceIds: string[]) => void;
  /** 單次搜尋實際會查詢的上限（後端 MaxSources），僅用於提示 */
  maxActive?: number;
  /** 來源速度／失效標記，由搜尋結果被動累積 */
  health?: Record<string, MangaSourceHealth>;
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

export default function MangaSourceMultiPicker({
  sources,
  value,
  onChange,
  maxActive,
  health,
  className = '',
}: MangaSourceMultiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MangaSourceCategoryId>('all');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 拖曳勾選：null = 沒在拖；true = 這次拖是「加入」；false = 這次拖是「移除」 */
  const dragModeRef = useRef<boolean | null>(null);
  /** 本次滑鼠指標序列已在 pointerdown 套用過的項目，供隨後的 click 去重 */
  const pointerAppliedRef = useRef<string | null>(null);

  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    setRecentIds(readRecentMangaSourceIds());
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const endDrag = () => {
      dragModeRef.current = null;
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [open]);

  const closePicker = () => {
    setOpen(false);
    setQuery('');
    setCategory('all');
    dragModeRef.current = null;
  };

  const categories = useMemo(
    () => getMangaSourceCategories(sources, recentIds),
    [recentIds, sources]
  );

  const visibleSources = useMemo(() => {
    const byCategory = sourcesInCategory(sources, category, recentIds);
    return filterMangaSources(byCategory, query);
  }, [category, query, recentIds, sources]);

  const applyPick = (sourceId: string, shouldSelect: boolean) => {
    if (shouldSelect === selected.has(sourceId)) return;
    if (shouldSelect) {
      setRecentIds(rememberMangaSourceId(sourceId));
    }
    onChange(
      shouldSelect ? [...value, sourceId] : value.filter((id) => id !== sourceId)
    );
  };

  const triggerLabel = (() => {
    if (value.length === 0) return '全部来源';
    if (value.length === 1) {
      const only = sources.find((source) => source.id === value[0]);
      return only ? getMangaSourceLabel(only) : value[0];
    }
    return `已选 ${value.length} 个源`;
  })();

  const overLimit = typeof maxActive === 'number' && value.length > maxActive;

  const toolbar = (
    <>
      <div className='flex flex-wrap gap-2 text-xs'>
        <button
          type='button'
          onClick={() => onChange([])}
          className='min-h-11 cursor-pointer rounded-2xl border border-gray-200 px-3 font-medium text-gray-700 transition-colors duration-200 hover:border-sky-400 dark:border-gray-800 dark:text-gray-200'
        >
          全部来源（清空选择）
        </button>
        <button
          type='button'
          onClick={() =>
            onChange(
              Array.from(new Set([...value, ...visibleSources.map((s) => s.id)]))
            )
          }
          className='min-h-11 cursor-pointer rounded-2xl border border-gray-200 px-3 font-medium text-gray-700 transition-colors duration-200 hover:border-sky-400 dark:border-gray-800 dark:text-gray-200'
        >
          勾选当前列表
        </button>
        <button
          type='button'
          onClick={() => {
            const drop = new Set(visibleSources.map((s) => s.id));
            onChange(value.filter((id) => !drop.has(id)));
          }}
          className='min-h-11 cursor-pointer rounded-2xl border border-gray-200 px-3 font-medium text-gray-700 transition-colors duration-200 hover:border-sky-400 dark:border-gray-800 dark:text-gray-200'
        >
          取消当前列表
        </button>
      </div>
      {overLimit && (
        <p className='text-xs text-amber-600 dark:text-amber-400'>
          已选 {value.length} 个，但单次搜索只会实际查询前 {maxActive} 个源。
        </p>
      )}
    </>
  );

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
            {sources.length} 个源 · 可多选
          </span>
        </span>
        <ChevronDown className='h-4 w-4 shrink-0 text-gray-400' />
      </button>

      <MangaSourceSheet
        open={open}
        onClose={closePicker}
        title='选择搜索来源'
        subtitle='可多选；鼠标按住拖过多个项目可连续勾选或取消'
        query={query}
        onQueryChange={setQuery}
        searchInputId='manga-source-multi-search'
        categories={categories}
        activeCategory={category}
        onCategoryChange={setCategory}
        toolbar={toolbar}
        disableListSelection
        onListPointerLeave={() => {
          dragModeRef.current = null;
        }}
        triggerRef={triggerRef}
      >
        <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
          {visibleSources.map((source) => {
            const Icon = CATEGORY_ICON[getMangaSourceCategory(source)];
            const active = selected.has(source.id);
            const healthLabel = formatMangaSourceHealth(health?.[source.id]);
            const healthFailed = health?.[source.id]?.failed === true;
            return (
              <button
                key={source.id}
                type='button'
                role='checkbox'
                aria-checked={active}
                // 鍵盤 Enter/Space 與觸控點擊走 click；滑鼠已在 pointerdown
                // 套用過的項目要在這裡去重，否則單擊會勾了又取消
                onClick={() => {
                  if (pointerAppliedRef.current === source.id) {
                    pointerAppliedRef.current = null;
                    return;
                  }
                  applyPick(source.id, !active);
                }}
                // 拖曳連選只在滑鼠上啟用：觸控有 implicit pointer capture，
                // pointerenter 不會派到其他項目，且 pointerdown 會誤觸捲動。
                // 起始項目必須在這裡就套用 —— pointerenter 不會對「指標已在其上」
                // 的元素再派送一次，而拖到別處放開時 click 的 target 是外層容器，
                // 兩者都救不到起點。
                onPointerDown={(event) => {
                  // 先清殘值：拖離後放開時 click 不會派送到本項目，
                  // 若不清，之後對同一項目的點擊會被誤判為「已套用」而吞掉
                  pointerAppliedRef.current = null;
                  if (event.pointerType !== 'mouse' || event.button !== 0) return;
                  dragModeRef.current = !active;
                  pointerAppliedRef.current = source.id;
                  applyPick(source.id, dragModeRef.current);
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType !== 'mouse') return;
                  if (dragModeRef.current === null) return;
                  applyPick(source.id, dragModeRef.current);
                }}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-colors duration-200 ${
                  active
                    ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                    : 'border-gray-200 text-gray-700 hover:border-sky-400 dark:border-gray-800 dark:text-gray-200'
                }`}
              >
                <span
                  aria-hidden='true'
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                    active
                      ? 'border-sky-500 bg-sky-500 text-white'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}
                >
                  {active ? '✓' : ''}
                </span>
                <Icon className='h-4 w-4 shrink-0 opacity-70' />
                <span className='min-w-0 flex-1 truncate text-sm font-medium'>
                  {getMangaSourceLabel(source)}
                </span>
                {healthLabel && (
                  <span
                    className={`shrink-0 text-[10px] tabular-nums ${
                      healthFailed
                        ? 'text-red-500 dark:text-red-400'
                        : 'text-gray-400 dark:text-gray-500'
                    }`}
                  >
                    {healthLabel}
                  </span>
                )}
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
