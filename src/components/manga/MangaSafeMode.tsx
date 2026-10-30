'use client';

import { Shield, ShieldCheck } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { currentMangaAdultView } from '@/lib/db.client';
import type { MangaAdultView } from '@/lib/manga.types';
import { MANGA_BROWSE_STATE_KEY, MANGA_SEARCH_STATE_KEY } from '@/lib/manga-browse-state';
import { useOverlayFocus } from '@/hooks/useOverlayFocus';

import { triggerGlobalError } from '@/components/GlobalErrorIndicator';

/** 詳情／閱讀頁收到 403 code=safe_mode 時顯示的訊息，也拿來判斷要不要給「关闭安全模式」 */
export const MANGA_SAFE_MODE_MESSAGE = '这部漫画在安全模式下不显示。';

/**
 * RUNTIME_CONFIG 是 window 全域，掛載後才讀，避免 hydration 不一致。
 * 掛載前回 null（未知），呼叫端要當成可能是安全模式處理。
 */
export function useMangaAdultView(): MangaAdultView | null {
  const [view, setView] = useState<MangaAdultView | null>(null);
  useEffect(() => {
    setView(currentMangaAdultView());
  }, []);
  return view;
}

/** 存到帳號後整頁重新載入；列表與搜尋的暫存結果可能含被藏的漫畫，一起清掉 */
async function setSafeMode(enabled: boolean) {
  const response = await fetch('/api/manga/safe-mode', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  sessionStorage.removeItem(MANGA_BROWSE_STATE_KEY);
  sessionStorage.removeItem(MANGA_SEARCH_STATE_KEY);
  window.location.reload();
}

function SafeModeOffDialog({
  openerRef,
  onClose,
}: {
  openerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [pending, setPending] = useState(false);
  // 背景 inert，關閉後焦點回開啟者
  useOverlayFocus(true, dialogRef, { modal: true, returnFocusRef: openerRef });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const confirm = async () => {
    setPending(true);
    try {
      await setSafeMode(false);
    } catch {
      triggerGlobalError('无法关闭安全模式，请检查网络后重试');
      setPending(false);
    }
  };

  return createPortal(
    <div className='fixed inset-0 z-[1000] flex items-center justify-center p-4'>
      <button
        type='button'
        aria-label='取消'
        tabIndex={-1}
        onClick={onClose}
        className='absolute inset-0 bg-black/50'
      />
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className='relative w-full max-w-sm rounded-3xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950'
      >
        <h2 id={titleId} className='text-base font-semibold text-gray-900 dark:text-gray-100'>
          关闭安全模式？
        </h2>
        <p id={bodyId} className='mt-2 text-sm text-gray-600 dark:text-gray-300'>
          成人源的漫画会重新出现在推荐、搜索、书架和历史里。
        </p>
        <div className='mt-5 flex justify-end gap-3'>
          <button
            type='button'
            autoFocus
            onClick={onClose}
            className='inline-flex min-h-11 items-center rounded-2xl px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'
          >
            取消
          </button>
          <button
            type='button'
            disabled={pending}
            onClick={confirm}
            className='inline-flex min-h-11 items-center rounded-2xl bg-sky-700 px-4 text-sm font-medium text-white transition-colors hover:bg-sky-800 disabled:opacity-60'
          >
            关闭安全模式
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** 盾牌、書架提示、詳情／閱讀頁的錯誤狀態共用同一個關閉確認框 */
function useSafeModeConfirm() {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  return {
    open: (opener: HTMLElement) => {
      openerRef.current = opener;
      setOpen(true);
    },
    dialog: open ? <SafeModeOffDialog openerRef={openerRef} onClose={close} /> : null,
  };
}

/** 頂欄盾牌：開啟一下就生效，關閉要確認；沒開放成人源的人看不到 */
export function MangaSafeModeButton({ view }: { view: MangaAdultView }) {
  const confirm = useSafeModeConfirm();
  const [pending, setPending] = useState(false);
  if (view === 'none') return null;
  const on = view === 'hidden';

  const turnOn = async () => {
    setPending(true);
    // 旁邊有人時要立刻有效，不等伺服器；失敗也維持清空，讓使用者再按一次重試
    const main = document.getElementById('manga-main');
    if (main) main.style.visibility = 'hidden';
    try {
      await setSafeMode(true);
    } catch {
      triggerGlobalError('无法开启安全模式，请检查网络后重试');
      setPending(false);
    }
  };

  return (
    <>
      <button
        type='button'
        aria-label='安全模式'
        aria-pressed={on}
        title='安全模式：隐藏成人源的漫画'
        disabled={pending}
        onClick={(event) => (on ? confirm.open(event.currentTarget) : turnOn())}
        className={`inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm transition-colors ${
          on
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
        }`}
      >
        {on ? (
          <ShieldCheck aria-hidden='true' className='h-5 w-5' />
        ) : (
          <Shield aria-hidden='true' className='h-5 w-5' />
        )}
        <span className='hidden md:inline'>安全模式</span>
      </button>
      {confirm.dialog}
    </>
  );
}

/** 「关闭安全模式」按鈕，按下開確認框；給書架提示與詳情／閱讀頁的錯誤狀態用 */
export function MangaSafeModeOffButton({ className }: { className: string }) {
  const confirm = useSafeModeConfirm();
  return (
    <>
      <button
        type='button'
        aria-haspopup='dialog'
        onClick={(event) => confirm.open(event.currentTarget)}
        className={className}
      >
        关闭安全模式
      </button>
      {confirm.dialog}
    </>
  );
}

/** 書架／歷史頁頂端提示；字面不提「成人」 */
export function MangaSafeModeNotice() {
  const view = useMangaAdultView();
  if (view !== 'hidden') return null;
  return (
    <div className='mb-4 flex flex-wrap items-center gap-x-2 rounded-2xl bg-emerald-50 px-4 py-1 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'>
      <ShieldCheck aria-hidden='true' className='h-4 w-4 shrink-0' />
      <span>安全模式已开启，部分漫画已隐藏。</span>
      <MangaSafeModeOffButton className='inline-flex min-h-11 items-center font-medium underline underline-offset-2' />
    </div>
  );
}
