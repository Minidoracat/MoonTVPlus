'use client';

import { type RefObject, useEffect } from 'react';

/**
 * 覆蓋層的焦點管理：開啟時焦點移進層內（層內已有焦點就不動），關閉時還給
 * `returnFocusRef`（沒給就還給開啟前的焦點元素），一律 preventScroll —— 觸發鈕常在
 * 頁面頂端，直接 focus 會把已捲到下面的頁面拉回去。
 *
 * `modal` 時把 body 其他子節點設 inert，鍵盤與輔助科技都碰不到背景。只給蓋住整個
 * 畫面（含 header）、以 createPortal(…, document.body) 掛在 body 下的覆蓋層用；
 * 閱讀器面板刻意讓 header 留著可按，不能 inert。
 */
export function useOverlayFocus(
  open: boolean,
  layerRef: RefObject<HTMLElement>,
  {
    modal = false,
    returnFocusRef,
  }: { modal?: boolean; returnFocusRef?: RefObject<HTMLElement | null> } = {}
) {
  useEffect(() => {
    const layer = layerRef.current;
    if (!open || !layer) return undefined;

    // 開啟當下就記住要回焦的對象；關閉時 ref 可能已指向別的節點
    const returnTo =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const inerted = modal
      ? Array.from(document.body.children).filter(
          (el) => !el.contains(layer) && !el.hasAttribute('inert')
        )
      : [];
    inerted.forEach((el) => el.setAttribute('inert', ''));

    if (!layer.contains(document.activeElement)) {
      layer
        .querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        ?.focus({ preventScroll: true });
    }

    return () => {
      inerted.forEach((el) => el.removeAttribute('inert'));
      if (returnTo && returnTo !== document.body && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, [layerRef, modal, open, returnFocusRef]);
}
