'use client';

import { X } from 'lucide-react';
import {
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  type MangaTapPoint,
  type MangaZoomLayout,
  getMangaZoomLayout,
  isMangaDoubleTap,
} from '@/lib/manga-reader';
import { useOverlayFocus } from '@/hooks/useOverlayFocus';

export interface MangaZoomTarget {
  src: string;
  alt: string;
  /** 原圖在畫面上的位置；開關動畫從這裡放大、縮回這裡 */
  rect: { left: number; top: number; width: number; height: number };
  /** 雙擊的位置，放大後留在手指下 */
  point: { x: number; y: number };
}

// ponytail: 固定放大 2.5 倍；要依原圖解析度或支援雙指縮放時再改
const ZOOM_SCALE = 2.5;
const ZOOM_ANIMATION_MS = 200;

/**
 * 縮成 1/ZOOM_SCALE 時要剛好疊回原圖：解「放大圖左緣 + o − o/s = 原圖左緣」得 transform-origin。
 * 開啟動畫（從原圖放大）與關閉動畫（縮回原圖）共用，關閉時用拖曳後的捲動量。
 */
function shrinkOntoOriginal(
  image: HTMLImageElement,
  scroller: HTMLDivElement,
  layout: MangaZoomLayout,
  rect: MangaZoomTarget['rect']
) {
  const k = 1 - 1 / ZOOM_SCALE;
  const imageLeft = layout.left - scroller.scrollLeft;
  const imageTop = layout.top - scroller.scrollTop;
  image.style.transformOrigin = `${(rect.left - imageLeft) / k}px ${
    (rect.top - imageTop) / k
  }px`;
  image.style.transform = `scale(${1 / ZOOM_SCALE})`;
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 閱讀器雙擊放大：全螢幕蓋一層，用原生捲動拖曳；再雙擊（或關閉鈕、Esc）縮回原位。
 *
 * 不在原頁面上 transform：直式模式的捲動容器是 body，對根捲動寫值在 iOS PWA 會出事
 * （見 CUSTOM_FEATURES 第 9 節）。放大放在獨立的捲動層，頁面捲動與頁碼追蹤都不受影響。
 */
export default function MangaZoomViewer({
  target,
  onClose,
}: {
  target: MangaZoomTarget;
  onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const lastTapRef = useRef<MangaTapPoint | null>(null);
  const closingRef = useRef(false);
  const [layout] = useState(() =>
    getMangaZoomLayout({
      rect: target.rect,
      point: target.point,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scale: ZOOM_SCALE,
    })
  );
  useOverlayFocus(true, layerRef, { modal: true });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const image = imageRef.current;
    const backdrop = backdropRef.current;
    if (!scroller || !image || !backdrop) return;
    scroller.scrollLeft = layout.scrollLeft;
    scroller.scrollTop = layout.scrollTop;
    if (prefersReducedMotion()) return;
    // 先疊在原圖上，套用後才放大：看起來就是從點的位置放大
    shrinkOntoOriginal(image, scroller, layout, target.rect);
    backdrop.style.opacity = '0';
    image.getBoundingClientRect();
    image.style.transition = `transform ${ZOOM_ANIMATION_MS}ms ease-out`;
    backdrop.style.transition = `opacity ${ZOOM_ANIMATION_MS}ms ease-out`;
    image.style.transform = '';
    backdrop.style.opacity = '';
  }, [layout, target.rect]);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const scroller = scrollerRef.current;
    const image = imageRef.current;
    const backdrop = backdropRef.current;
    if (prefersReducedMotion() || !scroller || !image || !backdrop) {
      onClose();
      return;
    }
    shrinkOntoOriginal(image, scroller, layout, target.rect);
    backdrop.style.opacity = '0';
    window.setTimeout(onClose, ZOOM_ANIMATION_MS);
  };

  // 每次 render 重綁，close 才讀得到最新的 onClose
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const tap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    if (isMangaDoubleTap(lastTapRef.current, tap)) {
      lastTapRef.current = null;
      close();
      return;
    }
    lastTapRef.current = tap;
  };

  return createPortal(
    <div
      ref={layerRef}
      role='dialog'
      aria-modal='true'
      aria-label='放大检视，双击图片还原'
      className='fixed inset-0 z-[60] select-none touch-manipulation'
    >
      <div ref={backdropRef} className='absolute inset-0 bg-black' />
      <div
        ref={scrollerRef}
        onClick={handleClick}
        className='absolute inset-0 overflow-auto overscroll-contain touch-manipulation'
      >
        <div
          className='relative'
          style={{
            width: layout.width + layout.left * 2,
            height: layout.height + layout.top * 2,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- 沿用閱讀器已載好的同一張圖 */}
          <img
            ref={imageRef}
            src={target.src}
            alt={target.alt}
            draggable={false}
            className='absolute max-w-none touch-manipulation'
            style={{
              left: layout.left,
              top: layout.top,
              width: layout.width,
              height: layout.height,
            }}
          />
        </div>
      </div>
      <button
        type='button'
        onClick={close}
        aria-label='还原大小'
        className='fixed right-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition-colors hover:bg-black/80'
        style={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <X aria-hidden='true' className='h-5 w-5' />
      </button>
    </div>,
    document.body
  );
}
