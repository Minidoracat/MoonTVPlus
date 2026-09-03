'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { MANGA_BROWSE_STATE_KEY } from '@/lib/manga-browse-state';

export default function RouteScrollReset() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === 'undefined' || !pathname?.startsWith('/manga') || pathname === '/manga/read') return;
    try {
      if (pathname === '/manga' && sessionStorage.getItem(MANGA_BROWSE_STATE_KEY)) return;
    } catch {
      // ignore unavailable session storage
    }

    const reset = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    reset();
    const rafId = window.requestAnimationFrame(reset);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [pathname]);

  return null;
}
