'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

import type { ActivityEvent } from '@/lib/activity-log';
import { getAuthInfoFromBrowserCookie } from '@/lib/auth';

// 站長操作紀錄：只觀察不干預（passive/capture，從不 preventDefault）
type Payload<E = ActivityEvent> = E extends ActivityEvent ? Omit<E, 't' | 'sid' | 'path'> : never;
type TapEvent = Extract<ActivityEvent, { type: 'tap' }>;

const ENDPOINT = '/api/activity-log';
const QUEUE_CAP = 500;
const FLUSH_AT = 50;
const BATCH = 100; // 與 API 每次上限一致
const INTERACTIVE =
  'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=switch],[role=checkbox],[role=option]';
const OPTS: AddEventListenerOptions = { capture: true, passive: true };

export default function ActivityLogger() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const logRef = useRef<((p: Payload) => void) | null>(null);
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (getAuthInfoFromBrowserCookie()?.role !== 'owner') return;

    const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const currentPath = () => location.pathname + location.search;
    const make = <P extends Payload>(p: P) => ({ ...p, t: Date.now(), sid, path: currentPath() });
    let queue: ActivityEvent[] = [];
    let stopped = false;
    let sending = false;

    const enqueue = (e: ActivityEvent) => {
      if (stopped) return;
      queue.push(e);
      if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
      if (queue.length >= FLUSH_AT) void flush(false);
    };
    const log = (p: Payload) => enqueue(make(p));

    const flush = async (beacon: boolean) => {
      if (stopped || queue.length === 0) return;
      if (beacon && navigator.sendBeacon) {
        while (queue.length > 0) {
          const blob = new Blob([JSON.stringify({ events: queue.splice(0, BATCH) })], { type: 'application/json' });
          navigator.sendBeacon(ENDPOINT, blob);
        }
        return;
      }
      if (sending) return;
      sending = true;
      try {
        while (queue.length > 0 && !stopped) {
          const batch = queue.splice(0, BATCH);
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
            keepalive: true,
          }).catch(() => null);
          if (res?.status === 403 || res?.status === 501) {
            stopped = true;
            queue = [];
          } else if (!res?.ok) {
            // 網路錯誤或 token 過期：放回佇列等下次
            queue = batch.concat(queue).slice(-QUEUE_CAP);
            break;
          }
        }
      } finally {
        sending = false;
      }
    };

    // 點擊：pointerdown→pointerup 位移 ≤10px、≤800ms 才算一次 tap；再等 700ms 看 click 有沒有到 document
    let down: { x: number; y: number; t: number } | null = null;
    let pending: { event: TapEvent; at: number; timer: number } | null = null;
    const settleTap = () => {
      if (!pending) return;
      window.clearTimeout(pending.timer);
      enqueue(pending.event);
      pending = null;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.isPrimary) down = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onPointerCancel = () => {
      down = null;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!e.isPrimary || !down) return;
      const start = down;
      down = null;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10 || Date.now() - start.t > 800) return;

      const target = e.target instanceof Element ? e.target : null;
      const hit = target?.closest(INTERACTIVE) ?? null;
      const el = hit ?? target;
      const tag = el?.tagName.toLowerCase() ?? '';
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      const name =
        el?.getAttribute('aria-label') ||
        (isField ? '' : (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40));
      const href = target?.closest('a')?.getAttribute('href') ?? undefined;

      settleTap();
      const event: TapEvent = make({
        type: 'tap',
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        sy: document.body.scrollTop,
        wy: window.scrollY,
        tag,
        name,
        href,
        interactive: hit !== null,
        clicked: false,
      });
      pending = { event, at: Date.now(), timer: window.setTimeout(settleTap, 700) };
    };
    const onClick = () => {
      if (pending && Date.now() - pending.at <= 700) pending.event.clicked = true;
    };

    const onError = (e: ErrorEvent) => {
      log({ type: 'error', message: String(e.message), source: `${e.filename}:${e.lineno}:${e.colno}` });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason: unknown = e.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const source = reason instanceof Error ? reason.stack?.split('\n')[1]?.trim() ?? '' : '';
      log({ type: 'error', message, source });
    };
    const onVisibility = () => {
      const state = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
      if (state === 'hidden') settleTap();
      log({ type: 'vis', state });
      if (state === 'hidden') void flush(true);
    };
    const onPageHide = () => {
      settleTap();
      void flush(true);
    };

    log({
      type: 'session',
      ua: navigator.userAgent,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio,
      standalone:
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
    });
    logRef.current = log;

    document.addEventListener('pointerdown', onPointerDown, OPTS);
    document.addEventListener('pointerup', onPointerUp, OPTS);
    document.addEventListener('pointercancel', onPointerCancel, OPTS);
    document.addEventListener('click', onClick, OPTS);
    document.addEventListener('visibilitychange', onVisibility, OPTS);
    window.addEventListener('pagehide', onPageHide, OPTS);
    window.addEventListener('error', onError, { passive: true });
    window.addEventListener('unhandledrejection', onRejection, { passive: true });
    const interval = window.setInterval(() => void flush(false), 10_000);

    return () => {
      logRef.current = null;
      document.removeEventListener('pointerdown', onPointerDown, OPTS);
      document.removeEventListener('pointerup', onPointerUp, OPTS);
      document.removeEventListener('pointercancel', onPointerCancel, OPTS);
      document.removeEventListener('click', onClick, OPTS);
      document.removeEventListener('visibilitychange', onVisibility, OPTS);
      window.removeEventListener('pagehide', onPageHide, OPTS);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearInterval(interval);
      settleTap();
      void flush(false);
    };
  }, []);

  // 路由變化（含 query）
  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    const from = lastPathRef.current;
    lastPathRef.current = path;
    if (from !== null && from !== path) logRef.current?.({ type: 'nav', from });
  }, [pathname, searchParams]);

  return null;
}
