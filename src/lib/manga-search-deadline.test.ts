/**
 * 搜尋 fan-out 的 per-source 上限。
 *
 * 搜尋會同時打所有來源，而兩條路徑（REST 的 searchManga、SSE 的
 * /api/manga/search/ws）最後都要等全部來源結束才算完成。少了 per-source
 * 上限，一顆卡住的來源就能讓整頁結果停到共用的 20 秒 deadline。
 *
 * 「卡住的來源」用永不 resolve 的 promise 表示，時間由 fake timer 推進 ——
 * 不用 sleep()，因為那會把測試綁在真實時鐘上，既慢又會在 CI 負載下 flake。
 *
 * 推進的量直接用 PER_SOURCE_SEARCH_TIMEOUT_MS，不寫死數字：這個常數在模組
 * 載入時就從 env 讀好了，而 import 會被 hoist 到檔案最上面，所以在測試裡
 * 設 process.env 是來不及的（改了也不會生效）。
 */

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig, isDegradedConfigObject } from '@/lib/config';
import type {
  MangaSearchItem,
  MangaSourceSearchResponse,
} from '@/lib/manga.types';
import {
  PER_SOURCE_SEARCH_TIMEOUT_MS,
  SuwayomiClient,
} from '@/lib/suwayomi.client';

const SOURCE_FAST = { id: 'fast', displayName: '快来源' };
const SOURCE_SLOW = { id: 'slow', displayName: '慢来源' };

/** 永遠不會 settle 的來源回應，代表「這顆來源卡住了」 */
function stalledForever(): Promise<MangaSourceSearchResponse> {
  return new Promise<MangaSourceSearchResponse>(() => {
    // 故意不呼叫 resolve/reject：只有 deadline 能讓它結束
  });
}

function itemFor(sourceId: string): MangaSearchItem {
  return {
    id: `${sourceId}-1`,
    sourceId,
    sourceName: sourceId,
    title: `${sourceId} 的漫画`,
    cover: '',
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  // 只有 SuwayomiConfig 這一段跟本測試有關；AdminConfig 其餘欄位（SiteConfig、
  // UserConfig…）在這裡不會被讀到，所以刻意只給部分欄位再轉型。
  const config = {
    SuwayomiConfig: {
      Enabled: true,
      ServerURL: 'http://suwayomi.local:4567',
      AuthMode: 'none',
      DefaultLang: 'zh',
      SourceIds: [],
      MaxSources: 10,
    },
  } as unknown as AdminConfig;
  (getConfig as jest.Mock).mockResolvedValue(config);
  (isDegradedConfigObject as jest.Mock).mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/**
 * 讓已排入的 microtask 跑完。
 *
 * Jest 27 沒有 advanceTimersByTimeAsync（那是 29 才有），所以推進假時鐘前後
 * 都要自己排空 microtask 佇列。promise 不受 fake timers 影響，
 * 因此 await Promise.resolve() 仍是真的讓出一個 tick。
 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/** 排空 microtask 後推進假時鐘，再排空一次讓 race 的結果傳遞出去 */
async function advance(ms: number): Promise<void> {
  await flushMicrotasks();
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

describe('searchMangaSourceWithDeadline', () => {
  it('來源在上限內回應時回傳 ok 與結果', async () => {
    const client = new SuwayomiClient();
    jest
      .spyOn(client, 'searchMangaSource')
      .mockResolvedValue({ source: SOURCE_FAST, results: [itemFor('fast')] });

    const outcome = await client.searchMangaSourceWithDeadline('x', SOURCE_FAST);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.results).toHaveLength(1);
    expect(outcome.sourceName).toBe('快来源');
  });

  it('來源卡住時在上限到達後回傳 failed，而不是一直等下去', async () => {
    const client = new SuwayomiClient();
    jest.spyOn(client, 'searchMangaSource').mockImplementation(stalledForever);

    const pending = client.searchMangaSourceWithDeadline('x', SOURCE_SLOW);
    // 只推進到上限；來源那邊永遠不會回來，所以能結束就證明是 deadline 生效
    await advance(PER_SOURCE_SEARCH_TIMEOUT_MS);
    const outcome = await pending;

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.error).toContain('超时');
  });

  it('上限之前不會提早放棄', async () => {
    const client = new SuwayomiClient();
    jest.spyOn(client, 'searchMangaSource').mockImplementation(stalledForever);

    let settled = false;
    const pending = client
      .searchMangaSourceWithDeadline('x', SOURCE_SLOW)
      .then((outcome) => {
        settled = true;
        return outcome;
      });

    await advance(PER_SOURCE_SEARCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await advance(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('逾時會 abort 傳給來源的 signal，讓底層請求能被回收', async () => {
    const client = new SuwayomiClient();
    let observed: AbortSignal | undefined;
    jest
      .spyOn(client, 'searchMangaSource')
      .mockImplementation((_keyword, _source, _page, signal) => {
        observed = signal;
        return stalledForever();
      });

    const pending = client.searchMangaSourceWithDeadline('x', SOURCE_SLOW);
    await advance(PER_SOURCE_SEARCH_TIMEOUT_MS);
    await pending;

    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(true);
  });

  it('來源自己 reject 時回傳 failed 並帶原始訊息', async () => {
    const client = new SuwayomiClient();
    jest
      .spyOn(client, 'searchMangaSource')
      .mockRejectedValue(new Error('上游 500'));

    const outcome = await client.searchMangaSourceWithDeadline('x', SOURCE_SLOW);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.error).toBe('上游 500');
  });
});

describe('searchManga fan-out', () => {
  function twoSources(client: SuwayomiClient): void {
    jest
      .spyOn(client, 'getSearchSources')
      .mockResolvedValue([SOURCE_FAST, SOURCE_SLOW] as never);
  }

  it('一顆來源卡住不會拖累其他來源的結果', async () => {
    const client = new SuwayomiClient();
    twoSources(client);
    jest
      .spyOn(client, 'searchMangaSource')
      .mockImplementation((_keyword, source) =>
        source.id === 'slow'
          ? stalledForever()
          : Promise.resolve({ source, results: [itemFor('fast')] })
      );

    const pending = client.searchManga('x');
    await advance(PER_SOURCE_SEARCH_TIMEOUT_MS);
    const result = await pending;

    // 快來源的結果照樣拿到
    expect(result.results.map((item) => item.sourceId)).toEqual(['fast']);
    // 慢來源歸到失敗，UI 才能顯示「這顆沒回來」而不是假裝沒有結果
    expect(result.failedSources).toHaveLength(1);
    expect(result.failedSources[0].sourceId).toBe('slow');
    expect(result.failedSources[0].error).toContain('超时');
    // attemptedSources 仍算兩顆，前端的「查了幾個來源」不會少算
    expect(result.attemptedSources).toBe(2);
  });

  it('measurements 兩顆都有，逾時那顆標記為 failed', async () => {
    const client = new SuwayomiClient();
    twoSources(client);
    jest
      .spyOn(client, 'searchMangaSource')
      .mockImplementation((_keyword, source) =>
        source.id === 'slow'
          ? stalledForever()
          : Promise.resolve({ source, results: [itemFor('fast')] })
      );

    const pending = client.searchManga('x');
    await advance(PER_SOURCE_SEARCH_TIMEOUT_MS);
    const result = await pending;

    expect(result.measurements).toHaveLength(2);
    expect(
      Object.fromEntries(
        result.measurements.map((item) => [item.sourceId, item.failed])
      )
    ).toEqual({ fast: false, slow: true });
  });

  it('去重仍然有效：兩顆來源回傳同一筆只留一份', async () => {
    const client = new SuwayomiClient();
    twoSources(client);
    const duplicate = itemFor('dup');
    jest
      .spyOn(client, 'searchMangaSource')
      .mockImplementation((_keyword, source) =>
        Promise.resolve({ source, results: [duplicate] })
      );

    const result = await client.searchManga('x');

    expect(result.results).toHaveLength(1);
    expect(result.failedSources).toHaveLength(0);
  });
});
