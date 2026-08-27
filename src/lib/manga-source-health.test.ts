import {
  formatMangaSourceHealth,
  readMangaSourceHealth,
  recordMangaSourceHealth,
} from '@/lib/manga-source-health';

const STORAGE_KEY = 'moontv_manga_source_health';
const TTL_MS = 6 * 60 * 60 * 1000;

describe('recordMangaSourceHealth / readMangaSourceHealth', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('寫入成功量測並可讀回', () => {
    recordMangaSourceHealth([{ sourceId: 'a', elapsedMs: 800, failed: false }]);
    const read = readMangaSourceHealth();
    expect(read.a.elapsedMs).toBe(800);
    expect(read.a.failed).toBe(false);
  });

  it('失敗的來源不保留 elapsedMs', () => {
    recordMangaSourceHealth([
      { sourceId: 'a', elapsedMs: 800, failed: true },
    ]);
    expect(readMangaSourceHealth().a).toEqual({
      failed: true,
      measuredAt: expect.any(Number),
    });
  });

  it('後續量測覆蓋同一來源的舊值', () => {
    recordMangaSourceHealth([{ sourceId: 'a', elapsedMs: 800, failed: false }]);
    recordMangaSourceHealth([{ sourceId: 'a', failed: true }]);
    expect(readMangaSourceHealth().a.failed).toBe(true);
    expect(readMangaSourceHealth().a.elapsedMs).toBeUndefined();
  });

  it('合併不同來源而非覆蓋整份', () => {
    recordMangaSourceHealth([{ sourceId: 'a', elapsedMs: 100, failed: false }]);
    recordMangaSourceHealth([{ sourceId: 'b', elapsedMs: 200, failed: false }]);
    expect(Object.keys(readMangaSourceHealth()).sort()).toEqual(['a', 'b']);
  });

  it('忽略空的 sourceId', () => {
    recordMangaSourceHealth([{ sourceId: '', elapsedMs: 100, failed: false }]);
    expect(readMangaSourceHealth()).toEqual({});
  });

  it('空清單不寫入', () => {
    recordMangaSourceHealth([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('超過 TTL 的紀錄讀取時被濾掉', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stale: { failed: false, elapsedMs: 100, measuredAt: Date.now() - TTL_MS - 1 },
        fresh: { failed: false, elapsedMs: 100, measuredAt: Date.now() },
      })
    );
    expect(Object.keys(readMangaSourceHealth())).toEqual(['fresh']);
  });

  it('形狀不對的紀錄被忽略，不會炸掉整份', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bad: { failed: 'no', measuredAt: 'soon' },
        good: { failed: false, elapsedMs: 100, measuredAt: Date.now() },
      })
    );
    expect(Object.keys(readMangaSourceHealth())).toEqual(['good']);
  });

  it('壞掉的 JSON 回空物件', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(readMangaSourceHealth()).toEqual({});
  });

  it('localStorage 寫入失敗時仍回傳記憶體結果', () => {
    // jsdom 的 localStorage 是 Proxy，jest.spyOn 取不到可 mock 的方法，
    // 直接換掉 Storage.prototype.setItem
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      const result = recordMangaSourceHealth([
        { sourceId: 'a', elapsedMs: 100, failed: false },
      ]);
      expect(result.a.elapsedMs).toBe(100);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('formatMangaSourceHealth', () => {
  const at = Date.now();

  it('沒有紀錄時不顯示', () => {
    expect(formatMangaSourceHealth(undefined)).toBeNull();
  });

  it('失敗顯示失效', () => {
    expect(formatMangaSourceHealth({ failed: true, measuredAt: at })).toBe(
      '失效'
    );
  });

  it('成功但沒有耗時不顯示', () => {
    expect(formatMangaSourceHealth({ failed: false, measuredAt: at })).toBeNull();
  });

  it.each([
    [800, '0.8s'],
    [1499, '1.5s'],
    [1500, '1.5s 慢'],
    [4999, '5.0s 慢'],
    [5000, '5s 很慢'],
    [12000, '12s 很慢'],
  ])('%dms 顯示為 %s', (elapsedMs, expected) => {
    expect(
      formatMangaSourceHealth({ failed: false, elapsedMs, measuredAt: at })
    ).toBe(expected);
  });
});
