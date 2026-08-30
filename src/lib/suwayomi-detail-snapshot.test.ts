/**
 * 一次詳情載入必須綁死在同一份 ResolvedSuwayomiConfig 上。
 *
 * manga(id:) 與 fetchChapters 是兩發上游請求。若兩者各自 resolve 一次設定，
 * 管理員在中間把 ServerURL 從 A 換成 B 時，會拼出「A 的漫畫 + B 的章節」——
 * 同一個 mangaId 在兩台伺服器是不同漫畫，而這份混合體還會被寫進 5 分鐘的
 * 詳情快取，把一次競態放大成 300 秒 × 所有使用者。
 *
 * 修法是 snapshot 貫穿 + 尾端一次有界（≤1）的 server 變更偵測重試。
 * 這裡鎖住：整輪同源、切換後回傳新伺服器的事實、重試不成迴圈、
 * 以及重試之後授權仍然要跑。
 */
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(() => false),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig, isDegradedConfigObject } from '@/lib/config';
import { SuwayomiClient } from '@/lib/suwayomi.client';

const SERVER_A = 'http://server-a.local:4567';
const SERVER_B = 'http://server-b.local:4567';
const SERVER_C = 'http://server-c.local:4567';
const MANGA_ID = '1307';
const SOURCE_ID = '123';
const DETAIL_OP = 'MangaDetail';
const CHAPTERS_OP = 'GET_MANGA_CHAPTERS_FETCH';
const FORBIDDEN = '无法读取来源限制设置，已暂时拒绝访问';

interface UpstreamCall {
  server: string;
  operation: 'detail' | 'chapters' | 'sources' | 'other';
}

/** 各伺服器上這部漫畫長得不一樣，回傳值因此能指認事實來自哪一台 */
function serverName(url: string): string {
  if (url.includes('server-a')) return 'A';
  if (url.includes('server-b')) return 'B';
  if (url.includes('server-c')) return 'C';
  return '?';
}

function upstreamResponse(payload: unknown): Response {
  const response = {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
  // 手搓的最小 Response：suwayomiFetch 只讀 ok/status/text
  return response as unknown as Response;
}

describe('詳情載入的 snapshot 貫穿與伺服器切換', () => {
  let client: SuwayomiClient;
  let calls: UpstreamCall[];
  let currentServer: string;
  let degraded: boolean;
  /** 這台伺服器上這部漫畫屬於哪個來源（用來製造「切過去後不被允許」） */
  let sourceIdByServer: Record<string, string>;
  /** 每次上游請求後的鉤子，測試用它在精確的時點切換伺服器 */
  let afterRequest: (call: UpstreamCall) => void;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new SuwayomiClient();
    calls = [];
    currentServer = SERVER_A;
    degraded = false;
    sourceIdByServer = { A: SOURCE_ID, B: SOURCE_ID, C: SOURCE_ID };
    afterRequest = () => undefined;

    (getConfig as jest.Mock).mockImplementation(
      async () =>
        ({
          SuwayomiConfig: {
            Enabled: true,
            ServerURL: currentServer,
            AuthMode: 'none',
            DefaultLang: 'zh',
            SourceIds: [],
            MaxSources: 10,
          },
        } as unknown as AdminConfig)
    );
    (isDegradedConfigObject as jest.Mock).mockImplementation(() => degraded);

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const server = serverName(String(url));
      const operation: UpstreamCall['operation'] = body.includes(DETAIL_OP)
        ? 'detail'
        : body.includes(CHAPTERS_OP)
        ? 'chapters'
        : body.includes('sources')
        ? 'sources'
        : 'other';
      const call: UpstreamCall = { server, operation };
      calls.push(call);
      afterRequest(call);

      if (operation === 'detail') {
        return upstreamResponse({
          data: {
            manga: {
              id: 1307,
              title: `${server} 标题`,
              sourceId: sourceIdByServer[server],
            },
          },
        });
      }
      if (operation === 'chapters') {
        return upstreamResponse({
          data: {
            fetchChapters: {
              chapters: [{ id: 1, mangaId: 1307, name: `${server} 第 1 话` }],
            },
          },
        });
      }
      if (operation === 'sources') {
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
    global.fetch = originalFetch;
  });

  it('manga 與 chapters 之間切換伺服器，兩發仍打同一台', async () => {
    afterRequest = (call) => {
      if (call.operation === 'detail' && call.server === 'A') {
        currentServer = SERVER_B;
      }
    };

    const detail = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });

    // 每一輪的 chapters 都跟著同一輪的 manga 走：不存在 A 漫畫配 B 章節
    const rounds = calls.filter(
      (call) => call.operation === 'detail' || call.operation === 'chapters'
    );
    expect(rounds.map((call) => `${call.server}:${call.operation}`)).toEqual([
      'A:detail',
      'A:chapters',
      'B:detail',
      'B:chapters',
    ]);
    // 尾端偵測到伺服器已變，回傳的是「現在這台」的事實
    expect(detail.title).toBe('B 标题');
    expect(detail.chapters[0].name).toBe('B 第 1 话');
  });

  it('切換後不會命中舊伺服器的快取', async () => {
    await client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });
    currentServer = SERVER_B;
    calls = [];

    const detail = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });

    expect(detail.title).toBe('B 标题');
    expect(calls.filter((call) => call.operation === 'detail')).toHaveLength(1);
    expect(calls.every((call) => call.server === 'B')).toBe(true);
  });

  it('連續切換 A→B→C 只重試一次，回傳第二輪的自洽事實', async () => {
    afterRequest = (call) => {
      if (call.operation !== 'detail') return;
      if (call.server === 'A') currentServer = SERVER_B;
      if (call.server === 'B') currentServer = SERVER_C;
    };

    const detail = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });

    expect(detail.title).toBe('B 标题');
    expect(detail.chapters[0].name).toBe('B 第 1 话');
    // 有界：第二輪之後不再偵測，絕不迴圈
    expect(calls.filter((call) => call.operation === 'detail')).toHaveLength(2);
  });

  it('重試之後仍要驗權：切過去的伺服器上該漫畫屬於未授權來源就拒絕', async () => {
    sourceIdByServer = { ...sourceIdByServer, B: '456' };
    afterRequest = (call) => {
      if (call.operation === 'detail' && call.server === 'A') {
        currentServer = SERVER_B;
      }
    };

    await expect(
      client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID })
    ).rejects.toThrow();
    // 確實重跑了 B 那一輪，拒絕來自對 B 事實的授權判斷
    expect(
      calls.filter((call) => call.operation === 'detail' && call.server === 'B')
    ).toHaveLength(1);
  });

  it('尾端讀到降級設定就不重試，並且 fail closed', async () => {
    afterRequest = (call) => {
      // 章節取回後才降級：這一輪的內部檢查都已通過，只剩尾端那道
      if (call.operation === 'chapters') degraded = true;
    };

    await expect(
      client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID })
    ).rejects.toThrow(FORBIDDEN);
    expect(calls.filter((call) => call.operation === 'detail')).toHaveLength(1);
  });
});
