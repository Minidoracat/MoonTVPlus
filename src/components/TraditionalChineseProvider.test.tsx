/**
 * 繁體介面轉換的回歸鎖：OpenCC 不是冪等的（「算法」→「演算法」再轉又多一個「演」），
 * 屬性被轉過一次後，自己寫入觸發的 MutationObserver 不能再轉。少了這道檢查會在
 * microtask 裡無限迴圈，標題含「演算法」的漫畫卡片一出現整頁就凍住。
 */
import { act, render } from '@testing-library/react';
import { setTimeout as sleep } from 'timers/promises';

import { TraditionalChineseProvider } from '@/components/TraditionalChineseProvider';

let calls = 0;
jest.mock('@/lib/opencc-client', () => ({
  getS2TConverter: () =>
    Promise.resolve((text: string) => {
      // 迴圈時不讓 jest 卡死：轉太多次直接失敗
      if (++calls > 50) throw new Error('converter called in a loop');
      return text.replace(/算法/g, '演算法');
    }),
}));

const flush = () => act(() => sleep(0));

it('自己寫入的屬性與文字不會再被轉一次', async () => {
  localStorage.setItem('interfaceTraditionalChinese', 'true');
  render(<TraditionalChineseProvider />);
  await flush();

  const button = document.createElement('button');
  button.setAttribute('aria-label', '加入书架：理想型算法');
  button.textContent = '理想型算法';
  document.body.appendChild(button);
  await flush();
  await flush();

  expect(button.getAttribute('aria-label')).toBe('加入书架：理想型演算法');
  expect(button.textContent).toBe('理想型演算法');
  expect(calls).toBeLessThan(10);
});
