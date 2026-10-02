'use client';

import { type ComponentProps, useState } from 'react';

import ProxyImage from '@/components/ProxyImage';

type MangaPageImageProps = ComponentProps<typeof ProxyImage> & {
  pageNumber: number;
  /** 只在目前頁附近轉圈：直式長篇上百頁同時轉圈很耗電，畫面外的也看不到 */
  showLoading: boolean;
};

/**
 * 閱讀器的一頁。圖片載好前在原位顯示「第 N 頁載入中」：單頁／雙頁模式的圖在載好前高度是 0，
 * 直式只有一塊灰底，都看不出是在載入還是卡住。載入失敗也收起提示，交給呼叫端或瀏覽器的破圖顯示。
 */
export default function MangaPageImage({
  pageNumber,
  showLoading,
  onLoad,
  onError,
  ...props
}: MangaPageImageProps) {
  const [settled, setSettled] = useState(false);

  return (
    <>
      {!settled && showLoading && (
        <div className='flex min-h-[50dvh] w-full flex-col items-center justify-center gap-3 text-sm text-gray-500 dark:text-gray-400'>
          <span
            aria-hidden='true'
            className='h-8 w-8 rounded-full border-2 border-gray-300 border-t-sky-500 motion-safe:animate-spin dark:border-gray-700 dark:border-t-sky-400'
          />
          第 {pageNumber} 页载入中…
        </div>
      )}
      <ProxyImage
        {...props}
        onLoad={(event) => {
          setSettled(true);
          onLoad?.(event);
        }}
        onError={(event) => {
          setSettled(true);
          onError?.(event);
        }}
      />
    </>
  );
}
