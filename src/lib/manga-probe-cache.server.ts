import 'server-only';

import { DbManager } from '@/lib/db';
import type { MangaSourceProbeEntry } from '@/lib/manga.types';

/**
 * 漫畫來源探測結果的伺服器端快取。
 *
 * 存 DB 而不是 per-process Map，因為這份資料有三個消費者：
 * 管理面板（要看上次測試時間）、一般使用者的選源面板（要看燈號與延遲）、
 * 以及未來可能的多 replica。放記憶體的話容器一重啟就歸零，
 * 而重測 53 個來源要對所有漫畫站各發兩次請求，不該因為部署就被迫重跑。
 *
 * 用獨立的 global key 而不是寫進 admin config：後者是整份
 * read-modify-write 且無 CAS，把每次測試結果混進去會擴大 lost update
 * 的受害範圍（可能弄掉來源白名單）。
 */

const CACHE_KEY = 'manga:source:probe';

/**
 * 超過這個時間就不再顯示燈號。
 *
 * 來源狀態變動很快（站方換域名、風控、擴充套件更新），一週前的綠燈沒有
 * 參考價值，顯示「未測試」比顯示過期結果誠實。
 */
const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MangaProbeCache {
  /** 最近一次「全部測試」完成的時間；單顆重測不會更新它 */
  testedAt: number;
  entries: Record<string, MangaSourceProbeEntry>;
}

const EMPTY: MangaProbeCache = { testedAt: 0, entries: {} };

function isEntry(value: unknown): value is MangaSourceProbeEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MangaSourceProbeEntry>;
  return (
    typeof entry.sourceId === 'string' &&
    typeof entry.testedAt === 'number' &&
    Boolean(entry.popular) &&
    Boolean(entry.search)
  );
}

/**
 * 讀取快取，過期的項目會被濾掉。
 *
 * 讀失敗回空而不是 throw：燈號是輔助資訊，DB 故障時面板與選源都該照常可用。
 */
export async function readMangaProbeCache(): Promise<MangaProbeCache> {
  try {
    const raw = await new DbManager().getGlobalValue(CACHE_KEY);
    if (!raw) return EMPTY;

    const parsed = JSON.parse(raw) as Partial<MangaProbeCache>;
    const now = Date.now();
    const entries: Record<string, MangaSourceProbeEntry> = {};
    for (const [id, entry] of Object.entries(parsed.entries || {})) {
      if (!isEntry(entry)) continue;
      if (now - entry.testedAt > PROBE_TTL_MS) continue;
      entries[id] = entry;
    }
    return {
      testedAt: typeof parsed.testedAt === 'number' ? parsed.testedAt : 0,
      entries,
    };
  } catch (error) {
    console.warn('读取漫画源探测缓存失败:', error);
    return EMPTY;
  }
}

/**
 * 併入新的探測結果。
 *
 * 併入而非覆寫：管理員可以只重測選取的幾顆，其餘的舊結果要保留。
 * `fullRun` 為 true（測了全部來源）才更新頂層 testedAt。
 */
export async function mergeMangaProbeCache(
  results: MangaSourceProbeEntry[],
  fullRun: boolean
): Promise<MangaProbeCache> {
  const current = await readMangaProbeCache();
  const entries = { ...current.entries };
  for (const entry of results) {
    entries[entry.sourceId] = entry;
  }

  const next: MangaProbeCache = {
    testedAt: fullRun ? Date.now() : current.testedAt,
    entries,
  };

  try {
    await new DbManager().setGlobalValue(CACHE_KEY, JSON.stringify(next));
  } catch (error) {
    // 寫入失敗不該讓「測試」這個動作失敗：結果已經在回應裡回給前端了
    console.warn('写入漫画源探测缓存失败:', error);
  }
  return next;
}
