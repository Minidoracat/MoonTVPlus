/**
 * @jest-environment node
 */

/**
 * 封面讀取的位元組上界。
 *
 * 這是防 OOM 的承重守衛：上游不送 content-length，唯一的保護就是邊讀邊累計。
 * 用 node 環境是因為 jsdom 沒有 ReadableStream，而 Jest 27 的 node 環境也沒有
 * 全域版本 —— 從 `node:stream/web` 取用。
 */

import { ReadableStream } from 'node:stream/web';

import { readAllBounded } from '@/lib/bounded-read';

/** 產生固定塊大小的 stream；`cancelled` 用來確認上游真的被取消 */
function makeStream(
  chunkSize: number,
  chunkCount: number
): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelledFlag = false;
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      emitted += 1;
      // 用可辨識的位元組，才能驗證內容不只是長度對
      controller.enqueue(new Uint8Array(chunkSize).fill(emitted));
    },
    cancel() {
      cancelledFlag = true;
    },
  });
  return { stream, cancelled: () => cancelledFlag };
}

// node:stream/web 的型別與 lib.dom 的 ReadableStream 不完全相同，
// 但執行期介面（getReader/read/cancel）一致
function asWebStream(
  stream: ReadableStream<Uint8Array>
): Parameters<typeof readAllBounded>[0] {
  return stream as unknown as Parameters<typeof readAllBounded>[0];
}

describe('readAllBounded 未超限', () => {
  it('回傳完整內容', async () => {
    const { stream } = makeStream(1024, 3);
    const out = await readAllBounded(asWebStream(stream), 8192);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(3072);
  });

  it('內容按順序拼接，不只是長度正確', async () => {
    const { stream } = makeStream(2, 3);
    const out = await readAllBounded(asWebStream(stream), 100);
    expect(Array.from(out ?? [])).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('剛好等於上限時仍接受（上限是「超過才拒絕」）', async () => {
    const { stream } = makeStream(100, 2);
    const out = await readAllBounded(asWebStream(stream), 200);
    expect(out?.length).toBe(200);
  });

  it('空 stream 回傳空 buffer 而不是 null', async () => {
    const { stream } = makeStream(10, 0);
    const out = await readAllBounded(asWebStream(stream), 100);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(0);
  });
});

describe('readAllBounded 超限', () => {
  it('超過上限回 null', async () => {
    const { stream } = makeStream(1024, 30);
    const out = await readAllBounded(asWebStream(stream), 8192);
    expect(out).toBeNull();
  });

  it('超限時取消上游，不把剩下的 body 收完', async () => {
    const { stream, cancelled } = makeStream(1024, 1000);
    const out = await readAllBounded(asWebStream(stream), 4096);
    expect(out).toBeNull();
    // 沒有取消就等於「拒絕了這張圖，卻仍然把整個巨大 body 收下來」，
    // 上界形同虛設
    expect(cancelled()).toBe(true);
  });

  it('第一塊就超限也能立刻放棄', async () => {
    const { stream, cancelled } = makeStream(9000, 5);
    const out = await readAllBounded(asWebStream(stream), 8192);
    expect(out).toBeNull();
    expect(cancelled()).toBe(true);
  });

  it('上限為 0 時任何內容都拒絕', async () => {
    const { stream } = makeStream(1, 1);
    const out = await readAllBounded(asWebStream(stream), 0);
    expect(out).toBeNull();
  });
});
