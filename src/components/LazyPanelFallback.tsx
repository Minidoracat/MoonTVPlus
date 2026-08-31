'use client';

import type { DynamicOptionsLoadingProps } from 'next/dynamic';

export default function LazyPanelFallback({
  error,
}: DynamicOptionsLoadingProps) {
  if (!error) return null;

  return (
    <div
      className='fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4'
      role='alert'
      aria-live='polite'
    >
      <div className='rounded-xl bg-white px-6 py-5 text-center shadow-xl dark:bg-gray-800'>
        <p className='text-sm text-gray-700 dark:text-gray-200'>
          功能載入失敗，請檢查網路後重新整理。
        </p>
        <button
          type='button'
          onClick={() => window.location.reload()}
          className='mt-4 rounded-lg bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600'
        >
          重新整理
        </button>
      </div>
    </div>
  );
}
