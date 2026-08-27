/**
 * WebP 內容協商。
 *
 * 判錯的後果不是「少省一點位元組」，而是把客戶端拒絕的格式送出去 ——
 * 配上 image route 的 `x-content-type-options: nosniff`，瀏覽器不會靠
 * sniffing 救回來，使用者直接看到破圖。
 */

import { acceptsWebp } from '@/lib/http-accept';

describe('acceptsWebp 接受', () => {
  it.each([
    ['Chrome 典型值', 'image/avif,image/webp,image/apng,*/*;q=0.8'],
    ['只列 webp', 'image/webp'],
    ['帶正 q 值', 'image/jpeg,image/webp;q=0.9'],
    ['大小寫混雜', 'IMAGE/WebP'],
    ['多餘空白', '  image/webp  ,  image/png '],
    ['q 值為 0.0 以外的小數', 'image/webp;q=0.1'],
  ])('%s', (_label, accept) => {
    expect(acceptsWebp(accept)).toBe(true);
  });
});

describe('acceptsWebp 拒絕', () => {
  it.each([
    ['明確 q=0', 'image/webp;q=0, image/jpeg'],
    ['q=0.0', 'image/webp;q=0.0'],
    ['整份沒有 webp', 'image/png,image/jpeg,*/*;q=0.8'],
    ['只有通配 */*', '*/*'],
    ['只有 image/*（通配不代表能解 WebP）', 'image/*'],
    ['空字串', ''],
  ])('%s', (_label, accept) => {
    expect(acceptsWebp(accept)).toBe(false);
  });

  it('缺少標頭', () => {
    expect(acceptsWebp(null)).toBe(false);
    expect(acceptsWebp(undefined)).toBe(false);
  });

  it('不會把 image/webp2 之類的前綴誤判成 webp', () => {
    expect(acceptsWebp('image/webp2')).toBe(false);
  });

  it('不會被別的型別裡出現的 webp 字樣騙到', () => {
    // substring 比對會在這裡誤判為接受
    expect(acceptsWebp('application/x-image/webp-thing')).toBe(false);
  });
});
