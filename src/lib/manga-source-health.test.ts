import {
  formatMangaSourceHealth,
  formatMangaSourceStatus,
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

  it('逾時的來源保留 timedOut 旗標', () => {
    const map = recordMangaSourceHealth([
      { sourceId: 'a', failed: true, timedOut: true },
    ]);
    expect(map.a).toMatchObject({ failed: true, timedOut: true });
    expect(readMangaSourceHealth().a.timedOut).toBe(true);
  });

  it('來源自己回報錯誤時不標 timedOut', () => {
    const map = recordMangaSourceHealth([
      { sourceId: 'a', failed: true, timedOut: false },
    ]);
    expect(map.a.timedOut).toBeUndefined();
  });

  it('成功的來源即使誤傳 timedOut 也不會被標記', () => {
    const map = recordMangaSourceHealth([
      { sourceId: 'a', failed: false, elapsedMs: 120, timedOut: true },
    ]);
    expect(map.a).toEqual(
      expect.objectContaining({ failed: false, elapsedMs: 120 })
    );
    expect(map.a.timedOut).toBeUndefined();
  });

  it('後續成功量測會清掉先前的 timedOut', () => {
    recordMangaSourceHealth([{ sourceId: 'a', failed: true, timedOut: true }]);
    const map = recordMangaSourceHealth([
      { sourceId: 'a', failed: false, elapsedMs: 90 },
    ]);
    expect(map.a.timedOut).toBeUndefined();
    expect(map.a.failed).toBe(false);
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

describe('formatMangaSourceStatus', () => {
  const at = Date.now();
  const probe = {
    popularOk: true,
    popularMs: 800,
    searchOk: true,
    searchMs: 2500,
    testedAt: at,
  };

  it('沒有任何資料時不顯示', () => {
    expect(formatMangaSourceStatus(undefined, undefined, 'search')).toBeNull();
  });

  it('看熱門與看搜尋取的是不同數字', () => {
    expect(formatMangaSourceStatus(probe, undefined, 'popular')?.label).toBe(
      '800ms'
    );
    expect(formatMangaSourceStatus(probe, undefined, 'search')?.label).toBe(
      '2.5s'
    );
  });

  it('延遲決定顏色：<1.5s 綠、其餘琥珀', () => {
    expect(formatMangaSourceStatus(probe, undefined, 'popular')?.tone).toBe(
      'good'
    );
    expect(formatMangaSourceStatus(probe, undefined, 'search')?.tone).toBe(
      'slow'
    );
  });

  it('該能力失敗時顯示失效', () => {
    const failed = { ...probe, searchOk: false };
    expect(formatMangaSourceStatus(failed, undefined, 'search')).toMatchObject({
      label: '失效',
      tone: 'bad',
    });
    // 另一個能力仍正常，不該被連帶標成失效
    expect(formatMangaSourceStatus(failed, undefined, 'popular')?.label).toBe(
      '800ms'
    );
  });

  it('probe 優先於被動量測', () => {
    const health = { failed: true, measuredAt: at };
    const status = formatMangaSourceStatus(probe, health, 'search');
    // 被動量測說失效，但管理員測試說可用 —— 以 probe 為準
    expect(status).toMatchObject({ label: '2.5s', source: 'probe' });
  });

  it('沒有 probe 時退回被動量測', () => {
    const health = { failed: false, elapsedMs: 900, measuredAt: at };
    expect(formatMangaSourceStatus(undefined, health, 'search')).toMatchObject({
      label: '0.9s',
      tone: 'good',
      source: 'passive',
    });
  });

  it('退回被動量測時，逾時標琥珀而非紅', () => {
    const health = { failed: true, timedOut: true, measuredAt: at };
    expect(formatMangaSourceStatus(undefined, health, 'search')).toMatchObject({
      label: '逾時',
      tone: 'slow',
      source: 'passive',
    });
  });
});

describe('formatMangaSourceHealth', () => {
  const at = Date.now();

  it('沒有紀錄時不顯示', () => {
    expect(formatMangaSourceHealth(undefined)).toBeNull();
  });

  it('來源自己回報錯誤顯示失效', () => {
    expect(formatMangaSourceHealth({ failed: true, measuredAt: at })).toBe(
      '失效'
    );
  });

  it('逾時顯示逾時，不可顯示失效', () => {
    // 3 秒切斷只代表這一次太慢；標成「失效」會讓使用者去停用其實健康的來源
    expect(
      formatMangaSourceHealth({ failed: true, timedOut: true, measuredAt: at })
    ).toBe('逾時');
  });

  it('成功但沒有耗時不顯示', () => {
    expect(formatMangaSourceHealth({ failed: false, measuredAt: at })).toBeNull();
  });

  it.each([
    [800, '0.8s'],
    [1499, '1.5s'],
    [1500, '1.5s 慢'],
    [2999, '3.0s 慢'],
  ])('%dms 顯示為 %s', (elapsedMs, expected) => {
    expect(
      formatMangaSourceHealth({ failed: false, elapsedMs, measuredAt: at })
    ).toBe(expected);
  });
});
