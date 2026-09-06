'use client';

import { usePathname, useRouter,useSearchParams } from 'next/navigation';
import NProgress from 'nprogress';
import { useEffect, useRef } from 'react';

// 创建全局钩子来拦截 router
let globalRouterRef: any = null;

export default function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const isNavigatingRef = useRef(false);
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    // 配置 NProgress
    NProgress.configure({
      showSpinner: false,
      trickleSpeed: 200,
      minimum: 0.08,
      easing: 'ease',
      speed: 200,
    });

    // 保存原始的 router 方法
    globalRouterRef = router;
    const originalPush = router.push;
    const originalReplace = router.replace;
    const originalBack = router.back;
    const originalForward = router.forward;

    /**
     * 路徑會變才顯示進度條（/play、/live 例外：參數變化也顯示）。
     * 導航中途折返回目前這頁（載入慢時按退出／返回）：Next 會取消前一次導航，
     * pathname 不會變、下面靠 pathname 的 effect 永遠不會 done，只能在這裡收掉。
     */
    const beginNavigation = (targetPathname: string, showOnParamChange = false) => {
      if (showOnParamChange || targetPathname !== previousPathnameRef.current) {
        isNavigatingRef.current = true;
        NProgress.start();
      } else if (isNavigatingRef.current) {
        isNavigatingRef.current = false;
        NProgress.done();
      }
    };

    // 拦截 router.push
    router.push = function (...args: Parameters<typeof originalPush>) {
      const targetUrl = args[0] as string;
      const targetPathname = new URL(targetUrl, window.location.href).pathname;
      const currentPathname = window.location.pathname;
      beginNavigation(targetPathname, currentPathname === '/play' || currentPathname === '/live');
      return originalPush.apply(this, args);
    };

    // 拦截 router.replace
    router.replace = function (...args: Parameters<typeof originalReplace>) {
      const targetUrl = args[0] as string;
      const targetPathname = new URL(targetUrl, window.location.href).pathname;
      const currentPathname = window.location.pathname;
      beginNavigation(targetPathname, currentPathname === '/play' || currentPathname === '/live');
      return originalReplace.apply(this, args);
    };

    // 拦截 router.back
    router.back = function () {
      isNavigatingRef.current = true;
      NProgress.start();
      return originalBack.apply(this);
    };

    // 拦截 router.forward
    router.forward = function () {
      isNavigatingRef.current = true;
      NProgress.start();
      return originalForward.apply(this);
    };

    // 监听所有链接点击事件（只負責跨路徑的起始提示）
    const handleAnchorClick = (event: MouseEvent) => {
      // 修飾鍵／中鍵是另開分頁，本頁不會導航，起了進度條就永遠收不掉
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor?.href || anchor.target || anchor.download) return;
      let target: URL;
      try {
        target = new URL(anchor.href, window.location.origin);
      } catch {
        return;
      }
      if (target.origin !== window.location.origin) return;
      // capture 階段看不到 React onClick 的 preventDefault，同路徑的點擊不一定真的導航；
      // 折返回目前這頁的 done() 交給 router.push／replace／popstate（Next Link 走 push）
      if (target.pathname !== previousPathnameRef.current) beginNavigation(target.pathname);
    };

    // 监听浏览器前进后退按钮（popstate 觸發時 location 已是目標頁）
    const handlePopState = () => {
      const { pathname } = window.location;
      beginNavigation(pathname, pathname === '/play' || pathname === '/live');
    };

    document.addEventListener('click', handleAnchorClick, true);
    window.addEventListener('popstate', handlePopState);

    return () => {
      // 恢复原始方法
      if (globalRouterRef) {
        globalRouterRef.push = originalPush;
        globalRouterRef.replace = originalReplace;
        globalRouterRef.back = originalBack;
        globalRouterRef.forward = originalForward;
      }

      document.removeEventListener('click', handleAnchorClick, true);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [router]);

  useEffect(() => {
    // 仅在页面路径变化时结束进度条，参数变化不触发
    if (isNavigatingRef.current) {
      NProgress.done();
      isNavigatingRef.current = false;
    }
    previousPathnameRef.current = pathname;
  }, [pathname, searchParams]);

  return null;
}
