/**
 * Safari 懶載入的回歸鎖：WebKit 在寫入 src 的當下就決定要不要延後載入，那一刻元素上
 * 還沒有 loading="lazy" 就立刻抓圖，之後補上也不會取消。React 18 依 props 順序寫屬性，
 * loading 排在 src 後面時，iPhone 一進 174 頁的單行本就會同時發出整本的圖片請求，
 * 把換下一話的請求卡在後面。
 */
import { render } from '@testing-library/react';

import ProxyImage from '@/components/ProxyImage';

it('loading 比 src 先寫入，Safari 才會延後載入畫面外的圖', () => {
  const { container } = render(
    <ProxyImage originalSrc='/api/manga/image?path=page-1' alt='' />
  );
  const names = container.querySelector('img')?.getAttributeNames() ?? [];

  expect(names).toContain('loading');
  expect(names.indexOf('loading')).toBeLessThan(names.indexOf('src'));
});
