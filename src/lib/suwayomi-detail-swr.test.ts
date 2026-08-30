/**
 * 詳情快取過期後的 stale-while-revalidate。
 *
 * 過了 TTL 讓下一位使用者空等一整輪（manga(id:) + fetchChapters，而後者還會
 * 讓 Suwayomi 去來源站重抓）不划算：手上有事實就先交出去，背景更新完下一位
 * 拿新的。危險的地方是背景那一輪：它沒有人 await，失敗時既不能炸成
 * unhandled rejection，也不能把使用者手上唯一一份事實刪掉或寫成負向快取。
 *
 * 時間用 Date.now 的 spy 控制、背景那一發用閘門擋住，兩者都不靠真實延遲，
 * 所以「stale 已經回來了但 refresh 還沒 resolve」這個時點是確定的。
 */
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(() => false),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig } from '@/lib/config';
import { SuwayomiClient } from '@/lib/suwayomi.client';

const MANGA_ID = '1307';
const SOURCE_ID = '123';
const DETAIL_OP = 'MangaDetail';
/** 與 SuwayomiClient.MANGA_DETAIL_TTL_MS 同值 */
const TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;

function upstreamResponse(payload: unknown): Response {
  const response = {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
  // 手搓的最小 Response：suwayomiFetch 只讀 ok/status/text
  return response as unknown as Response;
}

/**
 * 把背景那一輪跑到底。
 *
 * 整條鏈（fetch mock → graphqlRequest → 快取寫入）全是 microtask，沒有任何
 * 計時器，所以排空 microtask 佇列就等於「跑完」，不需要猜等待時間。
 * 最後補一次 macrotask：unhandled rejection 只在 macrotask 檢查點才被判定，
 * 而 jest 會把它變成整個 suite 的失敗 —— 這一跳是「背景失敗沒有漏出去」
 * 唯一真正生效的證明（在 jsdom 環境自己掛 process 監聽器是收不到的）。
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) {
    await Promise.resolve();
  }
  // 專案的 TypeScript 4.9 還沒有 Promise.withResolvers 的型別，只能用 executor
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('詳情快取的 stale-while-revalidate', () => {
  let client: SuwayomiClient;
  let nowMs: number;
  let upstreamTitle: string;
  let upstreamSourceId: string;
  let detailRequests: number;
  /** 擋住背景那一發：設了就卡在這裡，直到測試放行 */
  let gate: { promise: Promise<void>; release: () => void } | undefined;
  /** 讓 manga(id:) 查詢以網路錯誤失敗 */
  let detailFails: boolean;
  const originalFetch = global.fetch;

  function openGate(): void {
    let open = (): void => undefined;
    // 同上：TS 4.9 沒有 Promise.withResolvers
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    gate = {
      promise,
      release: () => {
        gate = undefined;
        open();
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    nowMs = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    client = new SuwayomiClient();
    upstreamTitle = '旧标题';
    upstreamSourceId = SOURCE_ID;
    detailRequests = 0;
    gate = undefined;
    detailFails = false;

    (getConfig as jest.Mock).mockResolvedValue({
      SuwayomiConfig: {
        Enabled: true,
        ServerURL: 'http://suwayomi.local:4567',
        AuthMode: 'none',
        DefaultLang: 'zh',
        SourceIds: [],
        MaxSources: 10,
      },
    } as unknown as AdminConfig);

    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes(DETAIL_OP)) {
        detailRequests += 1;
        if (gate) await gate.promise;
        if (detailFails) throw new Error('socket hang up');
        return upstreamResponse({
          data: {
            manga: {
              id: 1307,
              title: upstreamTitle,
              sourceId: upstreamSourceId,
            },
          },
        });
      }
      if (body.includes('GET_MANGA_CHAPTERS_FETCH')) {
        if (gate) await gate.promise;
        return upstreamResponse({
          data: {
            fetchChapters: {
              chapters: [
                { id: 1, mangaId: 1307, name: `${upstreamTitle} 章节` },
              ],
            },
          },
        });
      }
      if (body.includes('sources')) {
        return upstreamResponse({
          data: {
            sources: { nodes: [{ id: SOURCE_ID, name: '来源', lang: 'zh' }] },
          },
        });
      }
      return upstreamResponse({ data: {} });
    }) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  const load = () =>
    client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });

  it('過期後先回 stale，背景那一發 resolve 之後才換成新值', async () => {
    expect((await load()).title).toBe('旧标题');

    nowMs += TTL_MS + 1;
    upstreamTitle = '新标题';
    openGate();

    // 背景更新還卡在閘門後面，這次呼叫不等它
    expect((await load()).title).toBe('旧标题');
    expect(detailRequests).toBe(2);

    gate?.release();
    await settle();

    expect((await load()).title).toBe('新标题');
    // 更新成功後 at 重置，這一次是 fresh 命中，沒有再發
    expect(detailRequests).toBe(2);
  });

  it('兩個 stale 併發只起一發背景更新', async () => {
    await load();
    nowMs += TTL_MS + 1;
    upstreamTitle = '新标题';
    openGate();

    const [first, second] = await Promise.all([load(), load()]);

    expect(first.title).toBe('旧标题');
    expect(second.title).toBe('旧标题');
    expect(detailRequests).toBe(2);

    gate?.release();
    await settle();
    expect((await load()).title).toBe('新标题');
  });

  it('背景更新失敗：保留 stale、不寫負向快取、下次可再試', async () => {
    await load();
    nowMs += TTL_MS + 1;
    detailFails = true;

    // 背景那一發會失敗，但呼叫端拿到的仍是舊事實
    expect((await load()).title).toBe('旧标题');
    // 若背景那一輪的 rejection 漏了出去，jest 會直接判這個 suite 失敗；
    // 這個 case 能綠本身就是「沒有 unhandled rejection」的證明
    await settle();
    expect(detailRequests).toBe(2);

    // backoff 内不因流量重复打来源，所有请求都立即拿 stale。
    detailFails = false;
    upstreamTitle = '新标题';
    const duringBackoff = await Promise.all([load(), load(), load()]);
    expect(duringBackoff.map((item) => item.title)).toEqual([
      '旧标题',
      '旧标题',
      '旧标题',
    ]);
    expect(detailRequests).toBe(2);

    // backoff 到期后才允许下一轮背景重试。
    nowMs += RETRY_MS + 1;
    expect((await load()).title).toBe('旧标题');
    expect(detailRequests).toBe(3);

    await settle();
    expect((await load()).title).toBe('新标题');
    expect(detailRequests).toBe(3);
  });

  it('背景刷新发现来源已禁止时移除 stale，下一次 fail closed', async () => {
    await load();
    nowMs += TTL_MS + 1;
    upstreamSourceId = 'blocked-source';

    // 触发 refresh 的这次仍先拿旧事实；背景验权失败后必须清掉它。
    expect((await load()).title).toBe('旧标题');
    await settle();
    expect(detailRequests).toBe(2);

    await expect(load()).rejects.toThrow();
    expect(detailRequests).toBe(3);
  });

  it('冷啟動失敗仍然照拋，並且不留下空條目', async () => {
    detailFails = true;
    await expect(load()).rejects.toThrow();

    detailFails = false;
    // 條目已被刪除，下一次是全新的冷啟動而不是卡在舊 inflight 上
    expect((await load()).title).toBe('旧标题');
    expect(detailRequests).toBe(2);
  });
});
