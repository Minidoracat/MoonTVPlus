/**
 * 授權在「讀不到 admin 設定」時必須 fail closed。
 *
 * getConfig() 在 DB 故障時不會 throw，而是回傳臨時預設值，其 SourceIds 是空陣列，
 * 而空陣列在 getSources() 中代表「管理員不限制」。若把這兩者混為一談，
 * 設定儲存層故障就會解除所有來源限制（包含 NSFW 屏蔽）。
 *
 * 這裡 mock './config' 而不是真的停掉 kvrocks —— 那是整站 DB，
 * 為了驗一個布林值把登入／書架／播放紀錄一起弄掉不划算。
 */
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig, isDegradedConfigObject } from '@/lib/config';
import { SuwayomiClient } from '@/lib/suwayomi.client';

const FORBIDDEN = '无法读取来源限制设置，已暂时拒绝访问';

function configWith(sourceIds: string[]): AdminConfig {
  return {
    SuwayomiConfig: {
      Enabled: true,
      ServerURL: 'http://suwayomi.local:4567',
      AuthMode: 'none',
      DefaultLang: 'zh',
      SourceIds: sourceIds,
      MaxSources: 10,
    },
  } as AdminConfig;
}

/**
 * 降級狀態綁在「那一份 config 物件」上，不是全域旗標 ——
 * 所以 mock 也要以物件為判斷依據，否則測不到真正的授權分支。
 */
function setConfigState(degraded: boolean, sourceIds: string[] = []): void {
  const config = configWith(sourceIds);
  (getConfig as jest.Mock).mockResolvedValue(config);
  (isDegradedConfigObject as jest.Mock).mockImplementation(
    (candidate: unknown) => degraded && candidate === config
  );
}

describe('降級設定下的授權（fail closed）', () => {
  let client: SuwayomiClient;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    // 每個 case 用新 client，避免 sourcesCache 跨 case 汙染
    client = new SuwayomiClient();
    // jsdom 沒有 fetch，無法 spyOn，直接指派。
    // 任何實際外連都算失敗：fail closed 的前提是「還沒送出請求就被擋」
    fetchMock = jest.fn().mockRejectedValue(new Error('不應該送出上游請求'));
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('設定為降級（policy 未知）', () => {
    beforeEach(() => {
      setConfigState(true);
    });

    it('getSearchSources（指定單一來源）要拒絕，且不得外連', async () => {
      await expect(client.getSearchSources('123')).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getSearchSources（多來源）要拒絕', async () => {
      await expect(client.getSearchSources(['123', '456'])).rejects.toThrow(
        FORBIDDEN
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getSearchSources（未指定＝全部來源）要拒絕', async () => {
      await expect(client.getSearchSources()).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('searchManga 要拒絕（經由 getSearchSources）', async () => {
      await expect(client.searchManga('海', '123')).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getSourceFilters 要拒絕', async () => {
      await expect(client.getSourceFilters('123')).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getRecommendedManga 要拒絕', async () => {
      await expect(
        client.getRecommendedManga('123', 'POPULAR', 1)
      ).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('assertMangaAllowed 要拒絕（圖片代理入口）', async () => {
      await expect(client.assertMangaAllowed('1307')).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getMangaDetail 要拒絕，且不得先送 manga(id:) 查詢', async () => {
      await expect(
        client.getMangaDetail({ mangaId: '1307', sourceId: '123' })
      ).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getChapterSummaries 要拒絕，且不得先讀 summary cache 或外連', async () => {
      await expect(
        client.getChapterSummaries([{ mangaId: '1307', sourceId: '123' }])
      ).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getChapterPages 要拒絕，且不得先送 ChapterSource 反查', async () => {
      await expect(client.getChapterPages('6505')).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('assertPolicyKnown 本身要拒絕', async () => {
      await expect(client.assertPolicyKnown()).rejects.toThrow(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('設定正常（正常運作不可被誤擋）', () => {
    beforeEach(() => {
      setConfigState(false);
    });

    it('不因政策未知而拒絕，會往下走到實際查詢', async () => {
      // fetch 被 mock 成失敗，所以預期的是「上游錯誤」而非授權錯誤。
      // 關鍵是不能是 FORBIDDEN —— 那代表正常運作被 policyKnown 誤擋。
      await expect(client.getSearchSources('123')).rejects.not.toThrow(
        FORBIDDEN
      );
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

/**
 * 詳情快取（5 分鐘）的回歸鎖。
 *
 * 快取只可能造成兩種真實傷害，這裡各鎖一條：
 * 1. 變成授權旁路 —— 管理員停用來源後，命中快取的請求仍讀得到內容。
 * 2. 洩漏呼叫端的 fallback —— A 帶進去的 title/sourceName 被回給沒帶的 B。
 * 另外鎖住 realUrl 只放行絕對 http(s) 網址（它會變成前端的外連連結）。
 */
describe('getMangaDetail 的詳情快取', () => {
  const MANGA_ID = '1307';
  const SOURCE_ID = '123';
  const DETAIL_QUERY = 'MangaDetail';
  const CHAPTERS_QUERY = 'GET_MANGA_CHAPTERS_FETCH';

  let client: SuwayomiClient;
  let fetchMock: jest.Mock;
  /** 每次上游請求的 GraphQL body，三種查詢共用 endpoint，只能靠內容分辨 */
  let requestBodies: string[];
  let realUrl: string | undefined;
  let chapterRealUrl: string | undefined;
  let chaptersFail: boolean;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    setConfigState(false, []);
    client = new SuwayomiClient();
    requestBodies = [];
    realUrl = 'https://source.example/manga/1307';
    chapterRealUrl = 'https://source.example/chapter/1';
    chaptersFail = false;
    // 用 text() 而非 json()：suwayomiFetch 會在自己的 deadline 內把 body
    // 讀成字串再交給呼叫端解析。
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      requestBodies.push(body);
      let payload: unknown = { data: {} };
      if (body.includes(DETAIL_QUERY)) {
        // 刻意不給 description/status：那兩欄要留給呼叫端 fallback 驗證
        payload = {
          data: {
            manga: {
              id: 1307,
              title: '上游标题',
              sourceId: SOURCE_ID,
              realUrl,
            },
          },
        };
      } else if (body.includes(CHAPTERS_QUERY)) {
        if (chaptersFail) throw new Error('上游章节查询失败');
        payload = {
          data: {
            fetchChapters: {
              chapters: [
                {
                  id: 1,
                  mangaId: 1307,
                  name: '第 1 话',
                  realUrl: chapterRealUrl,
                },
              ],
            },
          },
        };
      } else if (body.includes('sources')) {
        payload = {
          data: {
            sources: { nodes: [{ id: SOURCE_ID, name: '来源', lang: 'zh' }] },
          },
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('併發的相同請求合併成一發上游', async () => {
    await Promise.all([
      client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID }),
      client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID }),
    ]);
    expect(requestBodies.filter((b) => b.includes(DETAIL_QUERY))).toHaveLength(
      1
    );
    expect(
      requestBodies.filter((b) => b.includes(CHAPTERS_QUERY))
    ).toHaveLength(1);
  });

  it('TTL 內重複請求不再打上游', async () => {
    await client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });
    await client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });
    expect(requestBodies.filter((b) => b.includes(DETAIL_QUERY))).toHaveLength(
      1
    );
    expect(
      requestBodies.filter((b) => b.includes(CHAPTERS_QUERY))
    ).toHaveLength(1);
  });

  it('5 分钟后在背景重新读取来源事实（呼叫端先拿到 stale）', async () => {
    await client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });
    const now = Date.now();
    const dateSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(now + 5 * 60_000 + 1);
    try {
      // 過期的這次不阻塞呼叫端：兩份事實由背景那一輪重抓
      await client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });
      // 背景鏈全是 microtask，排空即等於跑完（stale-while-revalidate 的
      // 完整行為另見 suwayomi-detail-swr.test.ts）
      for (let tick = 0; tick < 50; tick += 1) {
        await Promise.resolve();
      }
    } finally {
      dateSpy.mockRestore();
    }
    expect(requestBodies.filter((b) => b.includes(DETAIL_QUERY))).toHaveLength(
      2
    );
    expect(
      requestBodies.filter((b) => b.includes(CHAPTERS_QUERY))
    ).toHaveLength(2);
  });

  it('快取的是伺服器事實，呼叫端 fallback 不得互相汙染', async () => {
    const withFallback = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
      sourceName: '呼叫端来源名',
      description: '呼叫端简介',
    });
    const withoutFallback = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });

    expect(withFallback.description).toBe('呼叫端简介');
    expect(withFallback.sourceName).toBe('呼叫端来源名');
    // 上游沒給 description，第二位呼叫端就該是 undefined 而不是別人的值
    expect(withoutFallback.description).toBeUndefined();
    expect(withoutFallback.sourceName).toBe(SOURCE_ID);
    // 伺服器事實兩邊一致
    expect(withoutFallback.title).toBe('上游标题');
    expect(withFallback.title).toBe('上游标题');
  });

  it('命中快取仍要驗權：來源被移出白名單後必須拒絕', async () => {
    await client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID });
    setConfigState(false, ['999']);

    await expect(
      client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID })
    ).rejects.toThrow();
    // 拒絕是由每次都跑的授權檢查造成，不是因為快取失效重打上游
    expect(requestBodies.filter((b) => b.includes(DETAIL_QUERY))).toHaveLength(
      1
    );
  });

  it('上游失敗不留快取，下次重新嘗試', async () => {
    chaptersFail = true;
    await expect(
      client.getMangaDetail({ mangaId: MANGA_ID, sourceId: SOURCE_ID })
    ).rejects.toThrow();

    chaptersFail = false;
    const detail = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });
    expect(detail.chapters).toHaveLength(1);
    expect(requestBodies.filter((b) => b.includes(DETAIL_QUERY))).toHaveLength(
      2
    );
  });

  it('realUrl 只放行絕對 http(s) 網址', async () => {
    const absolute = await client.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });
    expect(absolute.realUrl).toBe('https://source.example/manga/1307');
    expect(absolute.chapters[0].realUrl).toBe(
      'https://source.example/chapter/1'
    );

    realUrl = '/manga/1307';
    chapterRealUrl = '/chapter/1';
    const relativeClient = new SuwayomiClient();
    const relative = await relativeClient.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });
    expect(relative.realUrl).toBeUndefined();
    expect(relative.chapters[0].realUrl).toBeUndefined();

    realUrl = 'javascript:alert(1)';
    chapterRealUrl = 'data:text/html,bad';
    const scriptClient = new SuwayomiClient();
    const script = await scriptClient.getMangaDetail({
      mangaId: MANGA_ID,
      sourceId: SOURCE_ID,
    });
    expect(script.realUrl).toBeUndefined();
    expect(script.chapters[0].realUrl).toBeUndefined();
  });
});

describe('getChapterSummaries 的摘要補抓', () => {
  const SOURCE_ID = 'summary-source';
  const OTHER_SOURCE_ID = 'summary-source-other';
  const BLOCKED_SOURCE_ID = 'summary-source-blocked';
  const READY_ID = '92001';
  const UNFETCHED_ID = '92002';
  const STALE_ID = '92005';
  const BLOCKED_ID = '92003';
  const MISMATCH_ID = '92004';
  const SUMMARY_QUERY = 'GetMangaChapterSummary';
  const CHAPTERS_QUERY = 'GET_MANGA_CHAPTERS_FETCH';

  let client: SuwayomiClient;
  let requestBodies: string[];
  let returnedSourceId: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    setConfigState(false, [SOURCE_ID]);
    client = new SuwayomiClient();
    requestBodies = [];
    returnedSourceId = SOURCE_ID;
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      requestBodies.push(body);
      const variables = JSON.parse(body).variables || {};
      let payload: unknown = { data: {} };

      if (body.includes(SUMMARY_QUERY)) {
        const mangaId = String(variables.id);
        const hasSummary = mangaId === READY_ID || mangaId === STALE_ID;
        payload = {
          data: {
            manga: {
              sourceId: returnedSourceId,
              chaptersLastFetchedAt:
                mangaId === STALE_ID
                  ? 1
                  : hasSummary
                    ? Math.floor(Date.now() / 1000)
                    : 0,
              chapters: { totalCount: hasSummary ? 7 : 0 },
              latestUploadedChapter:
                hasSummary ? { name: '第 7 话' } : null,
            },
          },
        };
      } else if (body.includes(CHAPTERS_QUERY)) {
        payload = {
          data: {
            fetchChapters: {
              chapters: [
                { id: 3, name: '第 3 话', chapterNumber: 3, uploadDate: 3 },
                { id: 1, name: '第 1 话', chapterNumber: 1, uploadDate: 1 },
                { id: 2, name: '第 2 话', chapterNumber: 2, uploadDate: 2 },
              ],
            },
          },
        };
      } else if (body.includes('sources')) {
        payload = {
          data: {
            sources: {
              nodes: [
                { id: SOURCE_ID, name: '摘要来源', lang: 'zh' },
                { id: OTHER_SOURCE_ID, name: '其他摘要来源', lang: 'zh' },
              ],
            },
          },
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('已抓取者直接讀摘要，未抓取者補抓並依章節順序取最後一話，之後命中 cache', async () => {
    const items = [
      { sourceId: SOURCE_ID, mangaId: READY_ID },
      { sourceId: SOURCE_ID, mangaId: UNFETCHED_ID },
    ];
    const expected = {
      [`${SOURCE_ID}+${READY_ID}`]: { count: 7, latestName: '第 7 话' },
      [`${SOURCE_ID}+${UNFETCHED_ID}`]: {
        count: 3,
        latestName: '第 3 话',
      },
    };

    await expect(client.getChapterSummaries(items)).resolves.toEqual(expected);
    expect(requestBodies.filter((body) => body.includes(SUMMARY_QUERY))).toHaveLength(2);
    expect(requestBodies.filter((body) => body.includes(CHAPTERS_QUERY))).toHaveLength(1);

    const requestCount = requestBodies.length;
    await expect(client.getChapterSummaries(items)).resolves.toEqual(expected);
    expect(requestBodies).toHaveLength(requestCount);
  });

  it('摘要過期時補抓章節', async () => {
    await expect(
      client.getChapterSummaries([
        { sourceId: SOURCE_ID, mangaId: STALE_ID },
      ])
    ).resolves.toEqual({
      [`${SOURCE_ID}+${STALE_ID}`]: { count: 3, latestName: '第 3 话' },
    });
    expect(requestBodies.filter((body) => body.includes(CHAPTERS_QUERY))).toHaveLength(1);
  });

  it('伺服器回傳的來源不在允許清單時略過，且不補抓章節', async () => {
    returnedSourceId = BLOCKED_SOURCE_ID;

    await expect(
      client.getChapterSummaries([
        { sourceId: SOURCE_ID, mangaId: BLOCKED_ID },
      ])
    ).resolves.toEqual({});
    expect(requestBodies.some((body) => body.includes('fetchChapters'))).toBe(
      false
    );
  });

  it('trueSourceId 與請求來源不同時略過，且不補抓章節', async () => {
    setConfigState(false, [SOURCE_ID, OTHER_SOURCE_ID]);
    returnedSourceId = OTHER_SOURCE_ID;

    await expect(
      client.getChapterSummaries([
        { sourceId: SOURCE_ID, mangaId: MISMATCH_ID },
      ])
    ).resolves.toEqual({});
    expect(requestBodies.some((body) => body.includes('fetchChapters'))).toBe(
      false
    );
  });
});
