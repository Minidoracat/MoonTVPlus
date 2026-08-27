/**
 * 取消訊號必須真的傳到底層 fetch，而且要涵蓋 body 讀取。
 *
 * 兩個曾經真實存在的 bug，各對應下面一組測試：
 *
 * 1. `searchMangaSource` 宣告了 `signal` 參數卻沒有往下傳（`graphqlRequest`
 *    當時沒有這個參數），於是 `controller.abort()` 是完全的 no-op。
 *    只 mock `searchMangaSource` 的測試抓不到這種斷鏈 —— 必須走真實的
 *    searchMangaSource → graphqlRequest → suwayomiFetch → fetch 鏈，
 *    直接檢查 fetch 收到的 init。
 *
 * 2. `suwayomiFetch` 在 fetch resolve（= header 抵達）當下就 clearTimeout
 *    並移除 abort 監聽，而 body 是呼叫端後來才讀的。上游送完 header 就停止
 *    送 body 時，那個 await 永不 settle 且已無人能取消它，socket 永久滯留。
 */

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig, isDegradedConfigObject } from '@/lib/config';
import {
  PER_SOURCE_SEARCH_TIMEOUT_MS,
  SuwayomiClient,
} from '@/lib/suwayomi.client';

const SOURCE = { id: 'a', displayName: '来源 A' };
const EMPTY_GRAPHQL = JSON.stringify({
  data: { fetchSourceManga: { mangas: [] } },
});

let fetchMock: jest.Mock;

/** 依 signal 取消的 promise，模擬真實 undici：abort 時 reject 而不是永久掛住 */
function abortable<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    });
  });
}

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
    text: async () => EMPTY_GRAPHQL,
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('signal 轉發到 fetch', () => {
  it('請求進行中呼叫端 abort，傳給 fetch 的 signal 也會 abort', async () => {
    const client = new SuwayomiClient();
    const controller = new AbortController();
    let inflight: AbortSignal | undefined;
    // 卡在 header 階段；abort 時會 reject，所以測試結束前 promise 會 settle，
    // suwayomiFetch 的 finally 得以 clearTimeout（不留下 20 秒真實計時器）
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      inflight = init.signal ?? undefined;
      return abortable(init.signal);
    });

    const pending = client
      .searchMangaSource('x', SOURCE, 1, controller.signal)
      .catch(() => 'rejected');
    for (let i = 0; i < 50 && !inflight; i += 1) await Promise.resolve();

    expect(inflight).toBeInstanceOf(AbortSignal);
    expect(inflight?.aborted).toBe(false);

    // suwayomiFetch 內部另有 20 秒 deadline 的 controller，
    // 呼叫端的 signal 必須與它合併而不是被覆寫掉
    controller.abort(new Error('deadline'));
    expect(inflight?.aborted).toBe(true);
    await expect(pending).resolves.toBe('rejected');
  });

  it('請求完全結束後才 abort 不會再傳播（清理是刻意的）', async () => {
    const client = new SuwayomiClient();
    const controller = new AbortController();

    await client.searchMangaSource('x', SOURCE, 1, controller.signal);
    const init = fetchMock.mock.calls[0][1] as RequestInit;

    // 連 body 都讀完了，suwayomiFetch 的 finally 已 clearTimeout + 移除監聽：
    // 呼叫端的 signal 若長期存活，不移除監聽會累積。
    controller.abort(new Error('too late'));
    expect(init.signal?.aborted).toBe(false);
  });

  it('呼叫端在發出前就已 abort 時，傳下去的 signal 已是 aborted', async () => {
    const client = new SuwayomiClient();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    await client.searchMangaSource('x', SOURCE, 1, controller.signal).catch(
      () => undefined
    );

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
});

describe('deadline 涵蓋 body 讀取', () => {
  it('讀 body 的當下，deadline 計時器仍然武裝', async () => {
    const client = new SuwayomiClient();
    let timersDuringBodyRead: number | undefined;
    // 最直接的不變式：`response.text()` 必須在計時器還沒被 clearTimeout 之前
    // 被呼叫。舊行為在 fetch resolve（= header 抵達）當下就清理，body 由呼叫端
    // 稍後讀 —— 屆時已無任何東西能中止它，上游停送 body 就永久滯留。
    //
    // 斷言「呼叫 text() 時 getTimerCount() > 0」而不是「promise 會 reject」：
    // 後者太寬，任何原因的 reject 都會通過（例如把 body 直接回 '{}' 而完全
    // 不讀 body，也會因為「返回空数据」而 reject）。
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => {
          timersDuringBodyRead = jest.getTimerCount();
          return Promise.resolve(EMPTY_GRAPHQL);
        },
      })
    );

    jest.useFakeTimers();
    await client.searchMangaSource('x', SOURCE, 1);

    expect(timersDuringBodyRead).toBeGreaterThan(0);
  });

  it('header 已到但 body 卡住時，deadline 仍能取消', async () => {
    const client = new SuwayomiClient();
    let bodySignal: AbortSignal | undefined;
    // fetch 成功 resolve（header 抵達），但 text() 只有在 signal abort 時才 settle。
    // 若 suwayomiFetch 在 fetch resolve 後就 clearTimeout + 移除監聽（舊行為），
    // 這裡永遠不會 settle，測試會逾時。
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      bodySignal = init.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => abortable<string>(init.signal),
      });
    });

    jest.useFakeTimers();
    const pending = client.searchMangaSourceWithDeadline('x', SOURCE);

    for (let i = 0; i < 100 && jest.getTimerCount() === 0; i += 1) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(PER_SOURCE_SEARCH_TIMEOUT_MS);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    // 關鍵斷言：body 卡住時，abort 真的傳到了那條請求
    expect(bodySignal?.aborted).toBe(true);
  });

  it('deadline 逾時後，實際發出的請求已被 abort', async () => {
    const client = new SuwayomiClient();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      abortable(init.signal)
    );

    jest.useFakeTimers();
    const pending = client.searchMangaSourceWithDeadline('x', SOURCE);

    for (let i = 0; i < 100 && jest.getTimerCount() === 0; i += 1) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(PER_SOURCE_SEARCH_TIMEOUT_MS);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });
});

describe('上游回應不是合法 JSON', () => {
  it('回明確錯誤而不是 SyntaxError', async () => {
    const client = new SuwayomiClient();
    // 反向代理故障時常見：200 但 body 是 HTML 錯誤頁
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>502 Bad Gateway</body></html>',
    });

    await expect(client.searchMangaSource('x', SOURCE, 1)).rejects.toThrow(
      'Suwayomi 返回的不是有效 JSON'
    );
  });
});
