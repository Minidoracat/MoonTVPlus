'use client';

import { Check, Copy, ExternalLink, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { isIOSStandaloneWebApp, toSafariOpenUrl } from '@/lib/ios-pwa';

interface PwaSafariPromptProps {
  className?: string;
}

export default function PwaSafariPrompt({ className = '' }: PwaSafariPromptProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setIsVisible(isIOSStandaloneWebApp());
    setCurrentUrl(window.location.href);
    setCanShare(typeof navigator.share === 'function');
  }, []);

  if (!isVisible || !currentUrl) {
    return null;
  }

  const copyCurrentUrl = async () => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const shareCurrentUrl = async () => {
    if (!navigator.share) {
      await copyCurrentUrl();
      return;
    }

    try {
      await navigator.share({
        title: document.title || 'MoonTVPlus',
        url: currentUrl,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      await copyCurrentUrl();
    }
  };

  const openInSafari = async () => {
    const safariUrl = toSafariOpenUrl(currentUrl);

    if (safariUrl) {
      window.location.href = safariUrl;
      return;
    }

    await shareCurrentUrl();
  };

  return (
    <div className={className}>
      <div className='rounded-xl border border-amber-300/50 bg-amber-50/90 p-3 shadow-sm backdrop-blur-sm dark:border-amber-500/30 dark:bg-amber-950/30'>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <div className='min-w-0'>
            <p className='text-sm font-semibold text-amber-900 dark:text-amber-100'>
              子母畫面需使用 Safari
            </p>
            <p className='mt-1 text-xs leading-relaxed text-amber-800/80 dark:text-amber-100/75'>
              iOS 主畫面 PWA 目前不支援 PiP；用 Safari 開啟同一頁即可使用。
            </p>
          </div>

          <div className='flex flex-wrap gap-2 sm:justify-end'>
            <button
              type='button'
              onClick={openInSafari}
              className='inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]'
            >
              <ExternalLink className='h-3.5 w-3.5' />
              用 Safari 開啟
            </button>

            {canShare && (
              <button
                type='button'
                onClick={shareCurrentUrl}
                className='inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-amber-300/70 bg-white/80 px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-900/50'
              >
                <Share2 className='h-3.5 w-3.5' />
                分享
              </button>
            )}

            <button
              type='button'
              onClick={copyCurrentUrl}
              className='inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-amber-300/70 bg-white/80 px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-900/50'
            >
              {copied ? <Check className='h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}
              {copied ? '已複製' : '複製連結'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
