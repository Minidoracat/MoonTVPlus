'use client';

import Link from 'next/link';
import { useMemo } from 'react';

import { MangaReadRecord, MangaSearchItem, MangaShelfItem } from '@/lib/manga.types';

import ProxyImage from './ProxyImage';

interface MangaCardProps {
  item: MangaSearchItem | MangaShelfItem | MangaReadRecord;
  href: string;
  className?: string;
  /** 章節資訊（最新話／總話數），藍字 */
  subtitle?: string;
  /** 作者、連載狀態等次要資訊，灰字一行 */
  meta?: string;
  /** 讀過的話，綠字；讓使用者在列表就看得出哪些已經在追 */
  progress?: string;
  badge?: string;
  updateCount?: number;
  /** 單一來源的列表（推荐）不必每張卡重複來源名 */
  showSource?: boolean;
}

export default function MangaCard({
  item,
  href,
  className,
  subtitle,
  meta,
  progress,
  badge,
  updateCount,
  showSource = true,
}: MangaCardProps) {
  const sourceName = useMemo(() => {
    if ('sourceName' in item) return item.sourceName;
    return '';
  }, [item]);

  return (
    <Link
      href={href}
      // block：卡片是 inline 的 <a> 包 block 子元素時，邊框會被切成碎段（推荐列表實測）
      // 位移／陰影只給真的能 hover 的裝置，且尊重減少動態效果；觸控點過不會卡在抬起狀態
      className={`group block overflow-hidden rounded-2xl border border-gray-200/70 bg-white/90 shadow-sm motion-safe:transition [@media(hover:hover)]:hover:shadow-xl motion-safe:[@media(hover:hover)]:hover:-translate-y-1 dark:border-gray-700 dark:bg-gray-900/80 ${className ?? ''}`}
    >
      <div className='relative aspect-[3/4] overflow-hidden bg-gray-100 dark:bg-gray-800'>
        {item.cover ? (
          <ProxyImage
            originalSrc={item.cover}
            alt=''
            className='h-full w-full object-cover motion-safe:transition motion-safe:duration-300 motion-safe:[@media(hover:hover)]:group-hover:scale-105'
          />
        ) : (
          <div className='flex h-full items-center justify-center text-sm text-gray-400'>暂无封面</div>
        )}
        {badge && (
          <span className='absolute left-3 top-3 rounded-full bg-black/65 px-2 py-1 text-xs text-white'>
            {badge}
          </span>
        )}
        {(updateCount ?? 0) > 0 && (
          <div
            style={{
              position: 'absolute',
              top: '10px',
              right: '10px',
              zIndex: 20,
              pointerEvents: 'none',
              width: 'auto',
              height: '24px',
            }}
          >
            <div
              className='motion-safe:[animation:ping-scale_1.5s_cubic-bezier(0,0,0.2,1)_infinite]'
              style={{
                position: 'absolute',
                inset: '0',
                borderRadius: '9999px',
                backgroundColor: 'rgb(14 165 233)',
              }}
            />
            <div
              className='motion-safe:[animation:pulse-scale_2.5s_cubic-bezier(0.4,0,0.6,1)_infinite]'
              style={{
                position: 'absolute',
                inset: '0',
                borderRadius: '9999px',
                backgroundColor: 'rgb(14 165 233)',
              }}
            />
            <div
              className='motion-safe:[animation:badge-scale_2s_ease-in-out_infinite]'
              style={{
                position: 'relative',
                height: '100%',
                padding: '0 8px',
                whiteSpace: 'nowrap',
                borderRadius: '9999px',
                background:
                  'linear-gradient(to bottom right, rgb(14 165 233), rgb(2 132 199))',
                color: 'white',
                fontSize: '11px',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow:
                  '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
              }}
            >
              未读 +{updateCount}
            </div>
          </div>
        )}
      </div>
      <div className='space-y-1 p-3'>
        <div
          className='line-clamp-2 min-h-[2.75rem] text-sm font-semibold text-gray-900 dark:text-gray-100'
          title={item.title}
        >
          {item.title}
        </div>
        {showSource && sourceName && (
          <div className='text-xs text-gray-500 dark:text-gray-400'>{sourceName}</div>
        )}
        {subtitle && (
          <div className='line-clamp-2 text-xs text-sky-600 dark:text-sky-400'>{subtitle}</div>
        )}
        {progress && (
          <div className='line-clamp-2 text-xs text-emerald-700 dark:text-emerald-400'>{progress}</div>
        )}
        {meta && <div className='line-clamp-1 text-xs text-gray-500 dark:text-gray-400'>{meta}</div>}
      </div>
    </Link>
  );
}
