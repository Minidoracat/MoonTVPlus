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
