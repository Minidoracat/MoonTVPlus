/**
 * realUrl 的舊 schema 相容協商。
 *
 * `MangaType.realUrl` / `ChapterType.realUrl` 在舊版 Suwayomi 不存在，把它選進
 * query 會被 GraphQL validation 判 FieldUndefined —— 沒有降級的話，整個詳情頁
 * 對舊伺服器 100% 失敗（而 realUrl 只是「去來源站看留言」的加分連結）。
 *
 * 反過來，降級只能由 unknown-field 觸發：把連線失敗、HTTP 500、一般 GraphQL
 * 錯誤當成 schema 差異，等於把暫時性故障永久記成「這台不支援 realUrl」，
 * 而且會把真正的錯誤藏在一次假成功的重試後面。這兩個方向各有 case 鎖住。
 */
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(() => false),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig } from '@/lib/config';
import { SuwayomiClient } from '@/lib/suwayomi.client';

const SOURCE_ID = '123';
const DETAIL_OP = 'MangaDetail';
const CHAPTERS_OP = 'GET_MANGA_CHAPTERS_FETCH';
/** 真實伺服器對未知欄位回的 validation 訊息 */
const UNKNOWN_FIELD =
  "Validation error (FieldUndefined@[manga/realUrl]): Field 'realUrl' in type 'MangaType' is undefined";

/** 上游回應：測試只需要 ok/status/text，suwayomiFetch 也只讀這三個 */
function upstreamResponse(payload: unknown, status = 200): Response {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
  // 手搓的最小 Response：suwayomiFetch 只讀 ok/status/text，其餘欄位不會被碰
  return response as unknown as Response;
}

/** GraphQL 只回被選到的欄位：legacy 查詢不會有 realUrl */
const mangaPayload = (withRealUrl: boolean) => ({
  data: {
    manga: {
      id: 1307,
      title: '上游标题',
      sourceId: SOURCE_ID,
      ...(withRealUrl
        ? { realUrl: 'https://source.example/manga/1307' }
        : undefined),
    },
  },
});

const chaptersPayload = (withRealUrl: boolean) => ({
  data: {
    fetchChapters: {
      chapters: [
        {
          id: 1,
          mangaId: 1307,
          name: '第 1 话',
          ...(withRealUrl
            ? { realUrl: 'https://source.example/manga/1307/1' }
            : undefined),
        },
      ],
    },
  },
});

const SOURCES_PAYLOAD = {
  data: { sources: { nodes: [{ id: SOURCE_ID, name: '来源', lang: 'zh' }] } },
};

describe('realUrl 舊 schema 降級', () => {
  let client: SuwayomiClient;
  let requestBodies: string[];
  /** MangaType / ChapterType 的 realUrl 能力可獨立演進 */
  let mangaHasRealUrl: boolean;
  let chapterHasRealUrl: boolean;
  /** 覆寫成非 schema 類的真錯，用來驗證「不遮蔽」 */
  let failFullQueryWith: 'http500' | 'network' | 'graphql' | undefined;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
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
    client = new SuwayomiClient();
    requestBodies = [];
    mangaHasRealUrl = false;
    chapterHasRealUrl = false;
    failFullQueryWith = undefined;

    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      requestBodies.push(body);
      const isDetailQuery = body.includes(DETAIL_OP);
      const isChaptersQuery = body.includes(CHAPTERS_OP);
      const withRealUrl = body.includes('realUrl');

      if (withRealUrl && (isDetailQuery || isChaptersQuery)) {
        if (failFullQueryWith === 'http500') {
          return upstreamResponse({ errors: [{ message: '爆炸' }] }, 500);
        }
        if (failFullQueryWith === 'network') {
          throw new Error('socket hang up');
        }
        if (failFullQueryWith === 'graphql') {
          return upstreamResponse({
            errors: [{ message: 'Internal server error' }],
          });
        }
        if (
          (isDetailQuery && !mangaHasRealUrl) ||
          (isChaptersQuery && !chapterHasRealUrl)
        ) {
          return upstreamResponse({ errors: [{ message: UNKNOWN_FIELD }] });
        }
      }

      if (isDetailQuery) {
        return upstreamResponse(mangaPayload(withRealUrl));
      }
      if (isChaptersQuery) {
        return upstreamResponse(chaptersPayload(withRealUrl));
      }
      if (body.includes('sources')) {
        return upstreamResponse(SOURCES_PAYLOAD);
      }
      return upstreamResponse({ data: {} });
    }) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('首撞 unknown-field 後降級，詳情仍可用且不再吐 realUrl', async () => {
    const detail = await client.getMangaDetail({
      mangaId: '1307',
      sourceId: SOURCE_ID,
    });

    expect(detail.title).toBe('上游标题');
    expect(detail.realUrl).toBeUndefined();
    expect(detail.chapters[0].realUrl).toBeUndefined();
    // 兩個欄位各自「先試完整、再退 legacy」＝各 2 發
    expect(requestBodies.filter((b) => b.includes(DETAIL_OP))).toHaveLength(2);
    expect(requestBodies.filter((b) => b.includes(CHAPTERS_OP))).toHaveLength(
      2
    );
  });

  it('降級結果記在 per-server capability 上，第二部漫畫不再重撞', async () => {
    await client.getMangaDetail({ mangaId: '1307', sourceId: SOURCE_ID });
    requestBodies = [];

    await client.getMangaDetail({ mangaId: '1308', sourceId: SOURCE_ID });

    const detailBodies = requestBodies.filter((b) => b.includes(DETAIL_OP));
    const chapterBodies = requestBodies.filter((b) => b.includes(CHAPTERS_OP));
    expect(detailBodies).toHaveLength(1);
    expect(chapterBodies).toHaveLength(1);
    expect(detailBodies[0]).not.toContain('realUrl');
    expect(chapterBodies[0]).not.toContain('realUrl');
  });

  it('新版伺服器不受影響：一發就成功並帶回 realUrl', async () => {
    mangaHasRealUrl = true;
    chapterHasRealUrl = true;

    const detail = await client.getMangaDetail({
      mangaId: '1307',
      sourceId: SOURCE_ID,
    });

    expect(detail.realUrl).toBe('https://source.example/manga/1307');
    expect(detail.chapters[0].realUrl).toBe(
      'https://source.example/manga/1307/1'
    );
    expect(requestBodies.filter((b) => b.includes(DETAIL_OP))).toHaveLength(1);
    expect(requestBodies.filter((b) => b.includes(CHAPTERS_OP))).toHaveLength(
      1
    );
  });

  it('MangaType 与 ChapterType 的 realUrl 能力分别记忆', async () => {
    mangaHasRealUrl = true;
    chapterHasRealUrl = false;

    const detail = await client.getMangaDetail({
      mangaId: '1307',
      sourceId: SOURCE_ID,
    });

    expect(detail.realUrl).toBe('https://source.example/manga/1307');
    expect(detail.chapters[0].realUrl).toBeUndefined();
    expect(requestBodies.filter((b) => b.includes(DETAIL_OP))).toHaveLength(1);
    expect(requestBodies.filter((b) => b.includes(CHAPTERS_OP))).toHaveLength(
      2
    );
  });

  it.each([
    ['HTTP 500', 'http500' as const],
    ['連線中斷', 'network' as const],
    ['一般 GraphQL 錯誤', 'graphql' as const],
  ])(
    '%s 不得被當成 schema 差異：不重試、不汙染能力快取',
    async (_label, mode) => {
      mangaHasRealUrl = true;
      chapterHasRealUrl = true;
      failFullQueryWith = mode;

      await expect(
        client.getMangaDetail({ mangaId: '1307', sourceId: SOURCE_ID })
      ).rejects.toThrow();
      // 真錯原樣上拋，不得偷偷再發一次 legacy 把錯誤蓋掉
      expect(requestBodies.filter((b) => b.includes(DETAIL_OP))).toHaveLength(
        1
      );

      // 故障恢復後仍先試完整選欄位 —— 暫時性錯誤沒有被記成「不支援」
      failFullQueryWith = undefined;
      requestBodies = [];
      const detail = await client.getMangaDetail({
        mangaId: '1307',
        sourceId: SOURCE_ID,
      });
      expect(detail.realUrl).toBe('https://source.example/manga/1307');
      expect(requestBodies.filter((b) => b.includes(DETAIL_OP))[0]).toContain(
        'realUrl'
      );
    }
  );

  it('legacy 查詢也失敗時就地放棄，不無限重試', async () => {
    // 連 legacy 都回 unknown-field（例如欄位名整個打錯）
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      requestBodies.push(body);
      if (body.includes(DETAIL_OP)) {
        return upstreamResponse({ errors: [{ message: UNKNOWN_FIELD }] });
      }
      if (body.includes('sources')) {
        return upstreamResponse(SOURCES_PAYLOAD);
      }
      return upstreamResponse({ data: {} });
    }) as unknown as typeof global.fetch;

    await expect(
      client.getMangaDetail({ mangaId: '1307', sourceId: SOURCE_ID })
    ).rejects.toThrow(/FieldUndefined/);
    expect(requestBodies.filter((b) => b.includes(DETAIL_OP))).toHaveLength(2);
  });
});
