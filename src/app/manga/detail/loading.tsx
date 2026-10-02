/**
 * 詳情頁骨架：路由切換（loading boundary）與頁面抓資料時共用同一個，兩段之間不會換一種骨架而閃一下。
 * 放在 detail 這層才有效：Next 14 的預取只會停在「被導覽到的那一段」裡的 boundary，
 * 上層 app/manga/loading.tsx 對 /manga → /manga/detail 不起作用（實測網址照樣等完整回應才切換）。
 */
import MangaLoadingStatus from '@/components/manga/MangaLoadingStatus';

export default function MangaDetailSkeleton() {
  return (
    <div className='space-y-6' aria-busy='true'>
      <MangaLoadingStatus label='正在载入漫画详情' />
      {/* 版面對齊真實詳情頁（手機封面是 112px 左欄），資料到了不會整塊跳動 */}
      <div className='grid grid-cols-[112px_1fr] gap-4 rounded-[28px] border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950 sm:p-6 md:grid-cols-[260px_1fr] md:gap-6'>
        <div className='aspect-[3/4] self-start animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800 md:rounded-3xl' />
        <div className='space-y-4'>
          <div className='h-8 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
          <div className='flex gap-2'>
            <div className='h-7 w-24 animate-pulse rounded-full bg-gray-200 dark:bg-gray-800' />
            <div className='h-7 w-20 animate-pulse rounded-full bg-gray-200 dark:bg-gray-800' />
          </div>
          <div className='space-y-3'>
            <div className='h-4 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
            <div className='h-4 w-11/12 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
            <div className='h-4 w-4/5 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
          </div>
          <div className='flex flex-wrap gap-3'>
            <div className='h-12 w-32 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800' />
            <div className='h-12 w-40 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800' />
            <div className='h-12 w-32 animate-pulse rounded-2xl bg-gray-200 dark:bg-gray-800' />
          </div>
        </div>
      </div>
      <div className='rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950'>
        <div className='mb-4 h-6 w-32 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
        <div className='space-y-3'>
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className='rounded-2xl border border-gray-200 px-4 py-3 dark:border-gray-700'>
              <div className='h-4 w-1/3 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
              <div className='mt-2 h-3 w-1/4 animate-pulse rounded bg-gray-200 dark:bg-gray-800' />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
