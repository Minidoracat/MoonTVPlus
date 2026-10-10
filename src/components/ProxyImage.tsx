'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  clearBangumiImageFallbackCacheIfFailed,
  ensureBangumiImagePrimaryProbed,
  isBangumiImageUrl,
  processImageUrl,
  tryApplyBangumiImageFallback,
  tryApplyDoubanImageFallback,
} from '@/lib/utils';

interface ProxyImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  originalSrc: string;
  displaySrc?: string;
  retryDelay?: number;
  retryOnError?: boolean;
}

const ProxyImage: React.FC<ProxyImageProps> = ({
  originalSrc,
  displaySrc,
  retryDelay = 2000,
  retryOnError = true,
  loading = 'lazy',
  decoding = 'async',
  onError,
  src: _src,
  ...props
}) => {
  const initialSrc = useMemo(
    () => displaySrc || processImageUrl(originalSrc),
    [displaySrc, originalSrc]
  );
  const [currentSrc, setCurrentSrc] = useState(initialSrc);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setCurrentSrc(initialSrc);
  }, [initialSrc]);

  // 主源图片域主页探测：失败则 sticky 走备源（替代原 5s complete 误判）。
  // 只有 Bangumi 图片会因探测结果换源；其他来源（漫画封面、豆瓣…）跑探测
  // 只是多打一个对 Bangumi origin 的无用请求并污染 console。
  useEffect(() => {
    if (displaySrc || !isBangumiImageUrl(originalSrc)) return;

    let cancelled = false;
    void (async () => {
      const reachable = await ensureBangumiImagePrimaryProbed();
      if (cancelled || reachable) return;
      setCurrentSrc(processImageUrl(originalSrc));
    })();

    return () => {
      cancelled = true;
    };
  }, [displaySrc, originalSrc]);

  const handleError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    const img = e.currentTarget;

    if (
      tryApplyDoubanImageFallback(img, originalSrc) ||
      tryApplyBangumiImageFallback(img, originalSrc)
    ) {
      setCurrentSrc(img.src);
      return;
    }

    if (clearBangumiImageFallbackCacheIfFailed(img, originalSrc)) {
      setCurrentSrc(processImageUrl(originalSrc));
      return;
    }

    if (retryOnError && !img.dataset.retried) {
      img.dataset.retried = 'true';
      window.setTimeout(() => {
        setCurrentSrc(initialSrc);
      }, retryDelay);
    }

    onError?.(e);
  };

  // loading 必須是第一個寫入的屬性：WebKit 在寫入 src 的當下就決定要不要延後載入，
  // React 18 又依 props 順序寫屬性。排在 src 後面時 Safari 會忽略 loading="lazy"，
  // 一進漫畫就把整話（單行本一百多頁）同時下載，後面的請求全被卡住。
  return (
    <img
      loading={loading}
      decoding={decoding}
      {...props}
      ref={imgRef}
      src={currentSrc}
      onError={handleError}
    />
  );
};

export default ProxyImage;
