/**
 * 取消訊號必須真的傳到底層 fetch。
 *
 * per-source deadline 靠一定會 settle 的計時器保證回應時間，但「放棄等待」
 * 之後那條連線也該被回收，否則使用者連續改關鍵字時，背景會疊出一堆
 * in-flight GraphQL mutation，Suwayomi 又各自對外部漫畫站保持連線。
 *
 * 這個測試存在的理由：`searchMangaSource` 曾經宣告了 `signal` 參數卻沒有
 * 往下傳（`graphqlRequest` 當時沒有這個參數），於是 `controller.abort()`
 * 是完全的 no-op。只 mock `searchMangaSource` 的測試抓不到這種斷鏈 ——
 * 必須走真實的 searchMangaSource → graphqlRequest → suwayomiFetch → fetch
 * 這條鏈，直接檢查 fetch 收到的 init。
 */

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig, isDegradedConfigObject } from '@/lib/config';
import { SuwayomiClient } from '@/lib/suwayomi.client';

const SOURCE = { id: 'a', displayName: '来源 A' };

let fetchMock: jest.Mock;

beforeEach(() => {
  const config = {
    SuwayomiConfig: {
      Enabled: true,
      ServerURL: 'http://suwayomi.local:4567',
      // 'none' 才不會多一次 login fetch，斷言才只針對 GraphQL 那一次
      AuthMode: 'none',
      DefaultLang: 'zh',
      SourceIds: [],
      MaxSources: 10,
    },
  } as unknown as AdminConfig;
  (getConfig as jest.Mock).mockResolvedValue(config);
  (isDegradedConfigObject as jest.Mock).mockReturnValue(false);

  fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { fetchSourceManga: { mangas: [] } } }),
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('searchMangaSource 的 signal 轉發', () => {
  it('請求進行中呼叫端 abort，傳給 fetch 的 signal 也會 abort', async () => {
    const client = new SuwayomiClient();
    const controller = new AbortController();
    let inflight: AbortSignal | undefined;
    // 永不 settle，模擬「來源卡住」——這才是需要取消的情境
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      inflight = init.signal ?? undefined;
      return new Promise(() => undefined);
    });

    void client.searchMangaSource('x', SOURCE, 1, controller.signal);
    for (let i = 0; i < 50 && !inflight; i += 1) await Promise.resolve();

    expect(inflight).toBeInstanceOf(AbortSignal);
    expect(inflight?.aborted).toBe(false);

    // suwayomiFetch 內部另有 20 秒 deadline 的 controller，
    // 呼叫端的 signal 必須與它合併而不是被覆寫掉
    controller.abort(new Error('deadline'));
    expect(inflight?.aborted).toBe(true);
  });

  it('請求結束後才 abort 不會再傳播（清理是刻意的）', async () => {
    const client = new SuwayomiClient();
    const controller = new AbortController();

    await client.searchMangaSource('x', SOURCE, 1, controller.signal);
    const init = fetchMock.mock.calls[0][1] as RequestInit;

    // 回應已取得，suwayomiFetch 的 finally 已 clearTimeout + 移除監聽：
    // 呼叫端的 signal 若長期存活，不移除監聽會累積。
    controller.abort(new Error('too late'));
    expect(init.signal?.aborted).toBe(false);
  });

  it('呼叫端在發出前就已 abort 時，傳下去的 signal 已是 aborted', async () => {
    const client = new SuwayomiClient();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    await client.searchMangaSource('x', SOURCE, 1, controller.signal);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it('沒有傳 signal 時仍有內建 deadline 的 signal，且不是 aborted', async () => {
    const client = new SuwayomiClient();

    await client.searchMangaSource('x', SOURCE, 1);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('deadline 逾時後，實際發出的請求已被 abort', async () => {
    const client = new SuwayomiClient();
    // 讓 fetch 永遠不 settle，逼 searchMangaSourceWithDeadline 走逾時分支
    fetchMock.mockImplementation(() => new Promise(() => undefined));

    jest.useFakeTimers();
    try {
      const pending = client.searchMangaSourceWithDeadline('x', SOURCE);

      // 等 deadline 計時器就位再推進，避免依賴猜測的 microtask 次數
      for (let i = 0; i < 100 && jest.getTimerCount() === 0; i += 1) {
        await Promise.resolve();
      }
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      const outcome = await pending;
      expect(outcome.status).toBe('failed');

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
