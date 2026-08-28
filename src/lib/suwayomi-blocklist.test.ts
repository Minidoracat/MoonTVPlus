/**
 * 來源黑名單（DisabledSourceIds）的授權回歸鎖。
 *
 * 語意：允許 ⟺ （白名單為空 或 id ∈ 白名單）且 id ∉ 黑名單。
 * 白名單「空陣列 = 不限制 = 全部開放」是反直覺但既定的語意，
 * 歷來多數 bug 都源自把「空」與「全關」搞混。
 *
 * 這些 case 存在的理由：先前 review 發現只要刪掉 fetchSources 的黑名單判斷、
 * 或把 getSearchSources 的 fallback 改回只吐白名單，既有的 policy 測試仍會全綠。
 * 也就是「屏蔽成人來源」這個 observable contract 完全沒有回歸保護。
 */
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
  isDegradedConfigObject: jest.fn(() => false),
}));

import type { AdminConfig } from '@/lib/admin.types';
import { getConfig, isDegradedConfigObject } from '@/lib/config';
import {
  isMangaSourceAllowed,
  MANGA_DISABLE_ALL_SENTINEL,
  matchesSourceLang,
} from '@/lib/manga.types';
import { SuwayomiClient } from '@/lib/suwayomi.client';

const SOURCES = [
  { id: 'a', name: 'Safe A', lang: 'zh' },
  { id: 'b', name: 'Adult B', lang: 'zh' },
  { id: 'c', name: 'Safe C', lang: 'zh' },
];

function setPolicy(sourceIds: string[], disabledSourceIds: string[]): void {
  (getConfig as jest.Mock).mockResolvedValue({
    SuwayomiConfig: {
      Enabled: true,
      ServerURL: 'http://suwayomi.local:4567',
      AuthMode: 'none',
      DefaultLang: 'zh',
      SourceIds: sourceIds,
      DisabledSourceIds: disabledSourceIds,
      MaxSources: 10,
    },
  } as AdminConfig);
}

/**
 * 讓 sources 查詢成功、其餘 GraphQL 一律回空（我們只驗過濾結果）。
 *
 * 用 `text()` 而不是 `json()`：`suwayomiFetch` 刻意在自己的 deadline 範圍內
 * 把 body 讀成字串再交給呼叫端解析（見該函式的說明）。
 */
function mockSourcesOk(): jest.Mock {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    const body = String((init as { body?: unknown })?.body ?? '');
    const payload = body.includes('sources')
      ? { data: { sources: { nodes: SOURCES } } }
      : { data: {} };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
  return fetchMock;
}

describe('isMangaSourceAllowed（寫入端與讀取端共用的唯一謂詞）', () => {
  it('白名單為空代表不限制', () => {
    expect(isMangaSourceAllowed('a', [], [])).toBe(true);
  });

  it('黑名單勝過「白名單為空」', () => {
    expect(isMangaSourceAllowed('b', [], ['b'])).toBe(false);
    expect(isMangaSourceAllowed('a', [], ['b'])).toBe(true);
  });

  it('黑名單勝過「白名單明確包含」', () => {
    expect(isMangaSourceAllowed('b', ['a', 'b'], ['b'])).toBe(false);
    expect(isMangaSourceAllowed('a', ['a', 'b'], ['b'])).toBe(true);
  });

  it('不在非空白名單內即拒絕', () => {
    expect(isMangaSourceAllowed('c', ['a', 'b'], [])).toBe(false);
  });

  it('哨兵讓所有真實 id 落空', () => {
    for (const id of ['a', 'b', 'c']) {
      expect(isMangaSourceAllowed(id, [MANGA_DISABLE_ALL_SENTINEL], [])).toBe(
        false
      );
    }
  });
});

describe('getSources 會套用黑名單', () => {
  let client: SuwayomiClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    (isDegradedConfigObject as jest.Mock).mockReturnValue(false);
    client = new SuwayomiClient();
    mockSourcesOk();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('白名單空 + 黑名單有值 → 只濾掉黑名單那個', async () => {
    setPolicy([], ['b']);
    const ids = (await client.getSources('zh')).map((s) => s.id);
    expect(ids).toEqual(['a', 'c']);
  });

  it('白名單與黑名單同時存在 → 黑名單優先', async () => {
    setPolicy(['a', 'b'], ['b']);
    const ids = (await client.getSources('zh')).map((s) => s.id);
    expect(ids).toEqual(['a']);
  });

  it('哨兵 → 全部拒絕', async () => {
    setPolicy([MANGA_DISABLE_ALL_SENTINEL], []);
    expect(await client.getSources('zh')).toEqual([]);
  });

  it('政策改變時不可命中舊快取（cache key 必須含兩份清單）', async () => {
    setPolicy([], []);
    expect((await client.getSources('zh')).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    // 同一個 client、同一個 lang，只有政策變了
    setPolicy([], ['b']);
    expect((await client.getSources('zh')).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('分隔字元不可讓兩組不同政策撞到同一個 key', async () => {
    setPolicy(['a', 'b'], []);
    expect((await client.getSources('zh')).map((s) => s.id)).toEqual(['a', 'b']);
    // join(',') 下 ['a','b'] 與 ['a,b'] 都是 'a,b' —— 必須不同 key
    setPolicy(['a,b'], []);
    expect(await client.getSources('zh')).toEqual([]);
  });
});

describe('assertSourceAllowed 對被停用的來源必須拒絕', () => {
  let client: SuwayomiClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    (isDegradedConfigObject as jest.Mock).mockReturnValue(false);
    client = new SuwayomiClient();
    mockSourcesOk();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('黑名單內的來源：getSourceFilters 拒絕', async () => {
    setPolicy([], ['b']);
    await expect(client.getSourceFilters('b')).rejects.toThrow();
  });

  it('黑名單內的來源：getRecommendedManga 拒絕', async () => {
    setPolicy([], ['b']);
    await expect(
      client.getRecommendedManga('b', 'POPULAR', 1)
    ).rejects.toThrow();
  });

  it('未被停用的來源不可被誤擋', async () => {
    setPolicy([], ['b']);
    // 會往下走到實際查詢（mock 回空 data），關鍵是不能是授權錯誤
    await expect(client.getSourceFilters('a')).resolves.toEqual([]);
  });

  it('getSearchSources 指定被停用的來源 → 拒絕', async () => {
    setPolicy([], ['b']);
    await expect(client.getSearchSources('b')).rejects.toThrow();
  });

  it('getSearchSources 多選時濾掉被停用的來源', async () => {
    setPolicy([], ['b']);
    const ids = (await client.getSearchSources(['a', 'b'])).map((s) => s.id);
    expect(ids).toEqual(['a']);
  });
});

describe('matchesSourceLang（來源語言可見性的唯一謂詞）', () => {
  it('不指定語言時全部通過', () => {
    expect(matchesSourceLang('zh', undefined)).toBe(true);
    expect(matchesSourceLang('en', undefined)).toBe(true);
    expect(matchesSourceLang(undefined, undefined)).toBe(true);
  });

  it('zh 涵蓋 zh-Hant 與 zh-Hans', () => {
    /*
     * 這是這個函式存在的理由。精確比對時 DefaultLang=zh 會把繁體與簡體
     * 來源整批排除，而它們既不參與預設搜尋、也不出現在使用者端的來源清單
     * —— 在 UI 上完全不可達。實測被排除的 6 顆裡 NoyAcg（zh-Hant）
     * 每次搜尋約 20 筆繁體結果。
     */
    expect(matchesSourceLang('zh', 'zh')).toBe(true);
    expect(matchesSourceLang('zh-Hant', 'zh')).toBe(true);
    expect(matchesSourceLang('zh-Hans', 'zh')).toBe(true);
  });

  it('只放寬「更廣的查詢涵蓋更窄的標籤」，不做任意前綴', () => {
    // zhx 不是 zh 的子標籤，必須是 `zh-` 開頭
    expect(matchesSourceLang('zhx', 'zh')).toBe(false);
    expect(matchesSourceLang('zhuang', 'zh')).toBe(false);
    // localsourcelang 以 'l' 開頭，不該被 'lo' 之類誤匹配
    expect(matchesSourceLang('localsourcelang', 'zh')).toBe(false);
  });

  it('更精確的查詢不被放寬回上層', () => {
    // 指定 zh-Hant 時不該回 zh 或 zh-Hans 的來源
    expect(matchesSourceLang('zh-Hant', 'zh-Hant')).toBe(true);
    expect(matchesSourceLang('zh', 'zh-Hant')).toBe(false);
    expect(matchesSourceLang('zh-Hans', 'zh-Hant')).toBe(false);
  });

  it('來源沒有 lang 時，只有「不指定語言」才通過', () => {
    expect(matchesSourceLang(undefined, 'zh')).toBe(false);
    expect(matchesSourceLang('', 'zh')).toBe(false);
  });

  it('不做大小寫正規化（刻意，會牽動快取 key）', () => {
    expect(matchesSourceLang('zh-Hant', 'zh-hant')).toBe(false);
  });
});
