/**
 * 來源健康／速度紀錄。
 *
 * 刻意不主動對每個來源發測試請求：那會觸發「請在外掛設定改網址／填 Token」這類
 * 錯誤、也等於替使用者去打漫畫站。改為沿用既有搜尋流程回報的耗時，被動累積。
 */

const STORAGE_KEY = 'moontv_manga_source_health';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 小時後視為過期，不再顯示

export interface MangaSourceHealth {
  /** 最近一次成功的耗時（毫秒）；失敗時為 undefined */
  elapsedMs?: number;
  /** 最近一次是否失敗 */
  failed: boolean;
  /** 量測時間 */
  measuredAt: number;
}

type HealthMap = Record<string, MangaSourceHealth>;

function isHealth(value: unknown): value is MangaSourceHealth {
  if (!value || typeof value !== 'object') return false;
  if (!('measuredAt' in value) || !('failed' in value)) return false;
  const measuredAt = Reflect.get(value, 'measuredAt');
  const failed = Reflect.get(value, 'failed');
  return typeof measuredAt === 'number' && typeof failed === 'boolean';
}

export function readMangaSourceHealth(): HealthMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    const now = Date.now();
    const out: HealthMap = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (!isHealth(entry)) continue;
      if (now - entry.measuredAt > TTL_MS) continue;
      out[id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordMangaSourceHealth(
  entries: Array<{ sourceId: string; elapsedMs?: number; failed: boolean }>
): HealthMap {
  if (typeof window === 'undefined' || entries.length === 0) return {};

  const next = readMangaSourceHealth();
  const measuredAt = Date.now();
  for (const entry of entries) {
    if (!entry.sourceId) continue;
    next[entry.sourceId] = {
      failed: entry.failed,
      measuredAt,
      ...(typeof entry.elapsedMs === 'number' && !entry.failed
        ? { elapsedMs: entry.elapsedMs }
        : {}),
    };
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota：只保留記憶體結果
  }
  return next;
}

/** 給選單顯示用的短標籤 */
export function formatMangaSourceHealth(
  health: MangaSourceHealth | undefined
): string | null {
  if (!health) return null;
  if (health.failed) return '失效';
  if (typeof health.elapsedMs !== 'number') return null;
  if (health.elapsedMs < 1500) return `${(health.elapsedMs / 1000).toFixed(1)}s`;
  if (health.elapsedMs < 5000) return `${(health.elapsedMs / 1000).toFixed(1)}s 慢`;
  return `${(health.elapsedMs / 1000).toFixed(0)}s 很慢`;
}
