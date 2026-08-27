/**
 * `Accept` 標頭的內容協商判斷。
 *
 * 放在獨立模組而不是留在 route 裡：這是純函式，值得被測試守著 ——
 * 判錯的後果是把客戶端不接受的格式送出去，配上 `nosniff` 就是一張破圖。
 *
 * 整個模組的原則是「不確定就當作不接受」，因為退路（JPEG）所有客戶端都能解，
 * 猜錯的代價不對稱：猜「接受」錯了是破圖，猜「不接受」錯了只是少省一點位元組。
 */

/**
 * RFC 9110 的 quality value：`0`、`1`，或最多三位小數的 `0.xxx` / `1.000`。
 *
 * 嚴格比對而不是 `Number(...)`：`q=abc` 會得到 NaN，而 `NaN !== 0` 為 true，
 * 於是損壞的標頭反而被當成「接受」—— 方向和上面的原則相反。
 */
const QUALITY_VALUE = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;

/**
 * 客戶端是否真的接受 WebP。
 *
 * 不能用 `accept.includes('image/webp')`：`Accept: image/webp;q=0, image/jpeg`
 * 的語意是「明確不要 WebP」，substring 比對卻會判成接受。
 *
 * 通配的 `image/*` 與 `*` + `/*` 一律不算支援：舊瀏覽器也會送這些，
 * 它們表達的是「什麼都收」而不是「我能解 WebP」。只有明確列出
 * `image/webp` 且 q 是合法且非零的值才算。
 */
export function acceptsWebp(accept: string | null | undefined): boolean {
  if (!accept) return false;

  return accept.split(',').some((part) => {
    const [rawType, ...params] = part.split(';');
    if (rawType.trim().toLowerCase() !== 'image/webp') return false;

    // 容忍等號旁的空白：RFC 9110 不允許，但寬鬆解析在這裡比較安全 ——
    // 若把 `q = 0` 當成「找不到 q」，就會退回預設的「接受」，
    // 正好與客戶端明確表達的拒絕相反。
    const q = params
      .map((param) => /^q\s*=\s*(.*)$/.exec(param.trim().toLowerCase()))
      .find((matched): matched is RegExpExecArray => matched !== null);
    if (!q) return true;

    const value = q[1].trim();
    // 非法 q（q=abc、q=-1、q=2、q=0.12345）一律當成不接受
    if (!QUALITY_VALUE.test(value)) return false;
    return Number(value) > 0;
  });
}
