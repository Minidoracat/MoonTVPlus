'use client';

import { saveMangaChapterNewestFirst } from '@/lib/manga-reader';

const OPTIONS = [
  { newestFirst: false, label: '最早在前', short: '最早' },
  { newestFirst: true, label: '最新在前', short: '最新' },
];

/**
 * 章節排序（詳情頁與閱讀器的章節面板共用）。兩個選項直接寫出「最早／最新在前」，
 * 不再用一顆「倒序／正序」按鈕 —— 看不出那是目前狀態還是按下去的結果。
 * 選擇會記住，下次進任何作品都沿用。
 */
export default function MangaChapterOrderToggle({
  newestFirst,
  onChange,
  compact = false,
}: {
  newestFirst: boolean;
  onChange: (newestFirst: boolean) => void;
  /** 窄面板只顯示「最早／最新」，可存取名稱仍是完整說法 */
  compact?: boolean;
}) {
  return (
    <div
      role='group'
      aria-label='章节排序'
      className='inline-flex shrink-0 rounded-2xl bg-gray-100 p-1 dark:bg-gray-900'
    >
      {OPTIONS.map((option) => {
        const active = option.newestFirst === newestFirst;
        return (
          <button
            key={option.label}
            type='button'
            aria-pressed={active}
            aria-label={compact ? option.label : undefined}
            onClick={() => {
              saveMangaChapterNewestFirst(option.newestFirst);
              onChange(option.newestFirst);
            }}
            className={`inline-flex min-h-11 cursor-pointer items-center rounded-xl px-3 text-sm font-medium transition-colors duration-200 ${
              active
                ? 'bg-white text-sky-700 shadow-sm dark:bg-gray-800 dark:text-sky-300'
                : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            {compact ? option.short : option.label}
          </button>
        );
      })}
    </div>
  );
}
