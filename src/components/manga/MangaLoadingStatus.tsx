'use client';

import { useEffect, useRef, useState } from 'react';

/** 等這麼久就說明是來源慢：禁漫內頁約 3 秒、巴卡冷啟動可到 16 秒 */
const SLOW_AFTER_SECONDS = 8;

/**
 * 路由 loading 換成頁面自己的骨架時是不同元件實例；同一個標籤在這段時間內被接手，
 * 就沿用原本的起點，免得「已等待 2 秒」消失又從頭數，看起來像重新開始。
 */
const HANDOFF_MS = 500;
const handoffs = new Map<string, { startedAt: number; endedAt: number }>();

/**
 * 載入中的進度提示：跑動的進度條＋已等待秒數。只有骨架在閃時，上游一慢就像當掉；
 * 秒數在跳代表還在等回應，等久了再說明是來源慢。
 */
export default function MangaLoadingStatus({
  label,
  inverted = false,
}: {
  label: string;
  /** 深色底（沉浸閱讀）用淺色字 */
  inverted?: boolean;
}) {
  const [seconds, setSeconds] = useState(0);
  const labelRef = useRef(label);
  labelRef.current = label;

  // 只在掛載時起算：閱讀器在「取頁面」與「回到上次位置」間換標籤時秒數要繼續累計
  useEffect(() => {
    // 接手用掛載時的標籤：詳情骨架交接時標籤不變，閱讀器卸載時也沒有接手者
    const key = labelRef.current;
    const previous = handoffs.get(key);
    const startedAt =
      previous && Date.now() - previous.endedAt < HANDOFF_MS
        ? previous.startedAt
        : Date.now();
    handoffs.delete(key);
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      handoffs.set(key, { startedAt, endedAt: Date.now() });
    };
  }, []);

  const slow = seconds >= SLOW_AFTER_SECONDS;
  return (
    <div
      className={`mx-auto w-full max-w-sm px-4 py-3 text-center ${
        inverted ? 'text-white/80' : 'text-gray-600 dark:text-gray-300'
      }`}
    >
      <div
        className={`h-1.5 overflow-hidden rounded-full ${
          inverted ? 'bg-white/15' : 'bg-sky-100 dark:bg-sky-950/60'
        }`}
      >
        <div className='h-full w-1/3 rounded-full bg-sky-500 motion-safe:animate-progress-indeterminate' />
      </div>
      {/* 只在文字變了（開始、變慢）時播報；每秒跳的秒數不進播報區 */}
      <p role='status' className='mt-2 text-sm'>
        {slow ? `${label}，来源回应较慢…` : `${label}…`}
      </p>
      {seconds >= 2 && (
        <p aria-hidden='true' className='mt-0.5 text-xs opacity-70'>
          已等待 {seconds} 秒
        </p>
      )}
    </div>
  );
}
