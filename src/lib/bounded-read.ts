/**
 * 有上界的串流讀取。
 *
 * 存在的理由：漫畫圖片代理要把封面讀進記憶體才能縮圖，而上游（Suwayomi）
 * **不送 content-length**，所以無法先看大小再決定要不要讀。路徑白名單只保證
 * URL 是 `/api/v1/manga/<id>/thumbnail`，不保證回應多大 —— 任一被允許但故障
 * 或惡意的來源都可以在該端點回一個巨大的 chunked body，而封面是一次載入
 * 二十幾張。少了上界，登入與播放共用的同一個 Node 程序會被打到 OOM。
 *
 * 放在獨立模組是為了可測：這段是承重的資源保護，不該只靠人眼審查。
 */

/**
 * 讀完整個 stream，但累計超過 `limit` 就放棄。
 *
 * @returns 完整內容，或 `null` 代表超過上限（此時已取消上游連線）
 */
export async function readAllBounded(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) {
        // 取消上游，不要繼續收一個我們無論如何都不會用的 body。
        // 對真實的 undici response body 實測 cancel() 約 2ms 返回。
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}
