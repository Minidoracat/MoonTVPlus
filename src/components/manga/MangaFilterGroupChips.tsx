'use client';

import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { MangaFilterGroupOption } from '@/lib/manga.types';

/** 收合時最多顯示幾個 chip（已選的永遠優先佔位） */
const COLLAPSED_COUNT = 24;
/** 超過這個項數才顯示群組內搜尋框（實測 Komiic 有 71 項） */
const SEARCH_THRESHOLD = 30;

interface MangaFilterGroupChipsProps {
  name: string;
  options: MangaFilterGroupOption[];
  /** 已勾選項的群組內原始 position */
  selected: number[];
  /**
   * 單項勾選／取消。
   *
   * 刻意不是 `onChange(完整清單)`：那需要用 props 的 `selected` 計算新清單，
   * 快速連點（拖選、雙擊）時第二次點擊讀到的還是**上一次 render 的舊值**，
   * 會蓋掉第一次的選擇。呼叫端應在 setState updater 內用 prev 計算。
   */
  onToggle: (position: number, checked: boolean) => void;
  /** 清除此群組全部勾選 */
  onClear: () => void;
}

/**
 * 來源分類的多選 chip 群組。
 *
 * 用 chip 而不是 `<select multiple>`：後者在手機上無法一眼看到已選內容，
 * iOS 的滾輪介面對 71 項（Komiic 實測）完全不可用。chip 與站內既有的
 * 來源多選（MangaSourceMultiPicker）同一設計語言。
 *
 * 已選的 chip 永遠置頂：收合狀態下使用者必須能看到自己勾了什麼，
 * 否則「已選 3」但畫面上一個都看不到，會以為選擇丟失。
 */
export default function MangaFilterGroupChips({
  name,
  options,
  selected,
  onToggle,
  onClear,
}: MangaFilterGroupChipsProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      // 搜尋時顯示全部符合項，不受收合限制 —— 使用者已明確表達要找東西
      return options.filter((option) =>
        option.name.toLowerCase().includes(keyword)
      );
    }

    // 已選置頂（各自維持原順序），收合時只留前 COLLAPSED_COUNT 個
    const picked = options.filter((option) => selectedSet.has(option.position));
    const rest = options.filter((option) => !selectedSet.has(option.position));
    const ordered = [...picked, ...rest];
    return expanded ? ordered : ordered.slice(0, COLLAPSED_COUNT);
  }, [expanded, options, query, selectedSet]);

  const toggle = (position: number) => {
    onToggle(position, !selectedSet.has(position));
  };

  const hiddenCount = options.length - COLLAPSED_COUNT;

  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='text-xs text-gray-500 dark:text-gray-400'>{name}</div>
        {selected.length > 0 && (
          <div className='flex items-center gap-2 text-xs'>
            <span className='text-sky-600 dark:text-sky-400'>
              已選 {selected.length}
            </span>
            <button
              type='button'
              onClick={onClear}
              className='cursor-pointer text-gray-500 transition-colors duration-200 hover:text-sky-600 dark:text-gray-400'
            >
              清除
            </button>
          </div>
        )}
      </div>

      {options.length > SEARCH_THRESHOLD && (
        <div className='relative'>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400'
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`在 ${options.length} 個${name}中搜尋`}
            aria-label={`搜尋${name}`}
            className='h-10 w-full rounded-2xl border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
          />
        </div>
      )}

      <div className='flex flex-wrap gap-2'>
        {visible.map((option) => {
          const active = selectedSet.has(option.position);
          return (
            <button
              key={option.position}
              type='button'
              role='checkbox'
              aria-checked={active}
              onClick={() => toggle(option.position)}
              className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-200 ${
                active
                  ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                  : 'border-gray-200 text-gray-700 hover:border-sky-400 dark:border-gray-700 dark:text-gray-200'
              }`}
            >
              {/* 勾號不只靠顏色表達選中狀態，色盲可辨 */}
              {active && <Check aria-hidden='true' className='h-3.5 w-3.5' />}
              {option.name}
            </button>
          );
        })}
        {visible.length === 0 && (
          <div className='py-2 text-xs text-gray-500 dark:text-gray-400'>
            沒有符合的項目
          </div>
        )}
      </div>

      {!query && hiddenCount > 0 && (
        <button
          type='button'
          onClick={() => setExpanded((prev) => !prev)}
          className='inline-flex min-h-9 cursor-pointer items-center gap-1 text-xs text-gray-500 transition-colors duration-200 hover:text-sky-600 dark:text-gray-400'
        >
          {expanded ? (
            <>
              <ChevronUp aria-hidden='true' className='h-3.5 w-3.5' />
              收合
            </>
          ) : (
            <>
              <ChevronDown aria-hidden='true' className='h-3.5 w-3.5' />
              展開全部 {options.length} 項
            </>
          )}
        </button>
      )}
    </div>
  );
}
