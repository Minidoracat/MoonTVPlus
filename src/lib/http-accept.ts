/**
 * `Accept` 標頭的內容協商判斷。
 *
 * 放在獨立模組而不是留在 route 裡：這是純函式，值得被測試守著 ——
 * 判錯的後果是把客戶端不接受的格式送出去，配上 `nosniff` 就是一張破圖。
 */

/**
 * 客戶端是否真的接受 WebP。
 *
 * 不能用 `accept.includes('image/webp')`：`Accept: image/webp;q=0, image/jpeg`
 * 的語意是「明確不要 WebP」，substring 比對卻會判成接受。
 *
 * 通配的 `image/*` 與 `*` + `/*` 一律不算支援：舊瀏覽器也會送這些，
 * 它們表達的是「什麼都收」而不是「我能解 WebP」。只有明確列出
 * `image/webp` 且 q 不為 0 才算。
 */
export function acceptsWebp(accept: string | null | undefined): boolean {
  if (!accept) return false;

  return accept.split(',').some((part) => {
    const [rawType, ...params] = part.split(';');
    if (rawType.trim().toLowerCase() !== 'image/webp') return false;

    const q = params
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith('q='));
    return !q || Number(q.slice(2)) !== 0;
  });
}
