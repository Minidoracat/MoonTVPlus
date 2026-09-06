'use client';

import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

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
   * 單項切換意圖（勾↔取消由呼叫端決定）。
   *
   * 刻意**只傳 position、不傳方向**：方向若在這裡用 render-time 的
   * `selected` 算出，同一 render 週期內的交錯操作（清除後立刻點選、
   * 同一顆連點兩次）讀到的都是舊值 —— 清除後想選回的那一下會被算成
   * 「取消」而被吞掉。呼叫端應在 setState updater 內用 prev 判斷方向。
   */
  onToggle: (position: number) => void;
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
  // 群組標題與 chip 容器的 aria 關聯。useId 產生的 id 含冒號，
  // 不能進 CSS selector，但作為 id 屬性與 aria-labelledby 合法
  const labelId = useId();

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      // 搜尋時顯示全部符合項，不受收合限制 —— 使用者已明確表達要找東西
      return options.filter((option) =>
        option.name.toLowerCase().includes(keyword)
      );
    }

    // 已選置頂（各自維持原順序）。收合時已選**永遠全部顯示**，
    // 未選項只補到 COLLAPSED_COUNT —— 若把已選一起截斷，「已選 30」
    // 但畫面只有 24 個全勾的 chip，看起來像選項只有這些且全被勾了，
    // 而第 25 個之後的已選項要取消還得先展開。
    const picked = options.filter((option) => selectedSet.has(option.position));
    const rest = options.filter((option) => !selectedSet.has(option.position));
    if (expanded) return [...picked, ...rest];
    return [
      ...picked,
      ...rest.slice(0, Math.max(0, COLLAPSED_COUNT - picked.length)),
    ];
  }, [expanded, options, query, selectedSet]);

  const hiddenCount = options.length - COLLAPSED_COUNT;

  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div
          id={labelId}
          className='text-xs text-gray-500 dark:text-gray-400'
        >
          {name}
        </div>
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
            placeholder={`在 ${options.length} 項中搜尋`}
            aria-label={`搜尋${name}`}
            className='h-10 w-full rounded-2xl border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-sky-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
          />
        </div>
      )}

      <div
        role='group'
        aria-labelledby={labelId}
        className='flex flex-wrap gap-2'
      >
        {visible.map((option) => {
          const active = selectedSet.has(option.position);
          return (
            <button
              key={option.position}
              type='button'
              role='checkbox'
              aria-checked={active}
              onClick={() => onToggle(option.position)}
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
