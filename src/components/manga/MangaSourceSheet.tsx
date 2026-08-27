'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { MangaSourceCategory, MangaSourceCategoryId } from '@/lib/manga-source-groups';

interface MangaSourceSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  query: string;
  onQueryChange: (value: string) => void;
  searchInputId: string;
  categories: MangaSourceCategory[];
  activeCategory: MangaSourceCategoryId;
  onCategoryChange: (id: MangaSourceCategoryId) => void;
  /** 分類 chips 下方的額外控制（例如多選的批次操作） */
  toolbar?: React.ReactNode;
  /** 清單內容；捲動容器與 safe-area 由本元件負責 */
  children: React.ReactNode;
  /** 供拖曳選取用：指標離開清單區域時通知 */
  onListPointerLeave?: () => void;
  /** 清單是否禁止文字選取（拖曳勾選時需要） */
  disableListSelection?: boolean;
  /** 關閉後要回焦的觸發元素 */
  triggerRef: React.RefObject<HTMLButtonElement>;
}

/**
 * 兩個 source picker 共用的 bottom-sheet 外殼。
 *
 * 這裡的 z-index、max-height、safe-area、focus trap 是踩過坑調出來的：
 * - z-[1000] 必須高於手機底欄的 z-[998]，否則最後幾列被遮住
 * - max-h + min-h-0 + overflow-hidden 才能讓內層 flex-1 overflow-y-auto 真的捲動
 * - 關閉時把焦點還給 trigger，Escape 也走同一條路
 * 不要複製這段到別處，改這裡就好。
 */
export default function MangaSourceSheet({
  open,
  onClose,
  title,
  subtitle,
  query,
  onQueryChange,
  searchInputId,
  categories,
  activeCategory,
  onCategoryChange,
  toolbar,
  children,
  onListPointerLeave,
  disableListSelection = false,
  triggerRef,
}: MangaSourceSheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // onClose 是父層每次 render 新建的箭頭函式。若讓 effect 依賴它，
  // 每次 re-render 都會 cleanup（focus 回 trigger）再重跑（focus 搜尋框），
  // 導致勾選項目或切分類後焦點被搶回搜尋框，鍵盤使用者無法連續操作。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    // 每次 keydown 才重新查詢，讓分類切換／搜尋過濾後的新項目也進入 Tab 循環
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) || []
      ).filter((el) => !el.hasAttribute('disabled'));
    searchInputRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open, triggerRef]);

  if (!open) return null;

  return createPortal(
    <div className='fixed inset-0 z-[1000] flex items-end justify-center overscroll-none sm:items-center sm:p-4'>
      <button
        type='button'
        aria-label='关闭漫画源选择'
        className='absolute inset-0 bg-black/50'
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby={`${searchInputId}-title`}
        className='relative flex max-h-[88dvh] min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-xl dark:border-gray-800 dark:bg-gray-950 sm:max-h-[80vh] sm:rounded-3xl sm:pb-0'
      >
        <div className='flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800'>
          <div>
            <h2
              id={`${searchInputId}-title`}
              className='text-sm font-semibold text-gray-900 dark:text-gray-100'
            >
              {title}
            </h2>
            <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
              {subtitle}
            </p>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-2xl text-gray-500 transition-colors duration-200 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-900 dark:hover:text-gray-100'
            aria-label='关闭'
          >
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='space-y-3 px-4 py-3'>
          <label className='sr-only' htmlFor={searchInputId}>
            搜索漫画源
          </label>
          <div className='relative'>
            <Search className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400' />
            <input
              id={searchInputId}
              ref={searchInputRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder='搜索源名称'
              className='h-11 w-full rounded-2xl border border-gray-200 bg-gray-50 py-2 pl-10 pr-3 text-sm text-gray-900 outline-none transition-colors duration-200 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
            />
          </div>

          <div className='flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'>
            {categories.map((item) => (
              <button
                key={item.id}
                type='button'
                aria-pressed={activeCategory === item.id}
                onClick={() => onCategoryChange(item.id)}
                className={`min-h-11 shrink-0 cursor-pointer rounded-full px-3 text-xs font-medium transition-colors duration-200 ${
                  activeCategory === item.id
                    ? 'bg-sky-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {toolbar}
        </div>

        <div
          className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 ${
            disableListSelection ? 'select-none' : ''
          }`}
          onPointerLeave={onListPointerLeave}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
