/**
 * 來源健康／速度紀錄。
 *
 * 刻意不主動對每個來源發測試請求：那會觸發「請在外掛設定改網址／填 Token」這類
 * 錯誤、也等於替使用者去打漫畫站。改為沿用既有搜尋流程回報的耗時，被動累積。
 */

import type { MangaSourceProbeSummary } from '@/lib/manga.types';

const STORAGE_KEY = 'moontv_manga_source_health';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 小時後視為過期，不再顯示

export interface MangaSourceHealth {
  /** 最近一次成功的耗時（毫秒）；失敗時為 undefined */
  elapsedMs?: number;
  /** 最近一次是否失敗 */
  failed: boolean;
  /**
   * 失敗是否只是超過 per-source 搜尋上限。
   *
   * 逾時不等於來源壞掉：3 秒切斷只說明這一次太慢，來源本身可能完全正常。
   * 這筆紀錄會保留 6 小時，若把暫時的慢顯示成「失效」，使用者會照著去停用
   * 其實健康的來源。
   */
  timedOut?: boolean;
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

/**
 * 一次量測回報。
 *
 * 具名匯出而不是在呼叫端各寫一份 inline 型別：搜尋頁的 pendingHealthRef 與
 * 這裡必須同步，欄位漏傳（例如少了 timedOut）才會被 tsc 抓到。
 */
export interface MangaSourceHealthEntry {
  sourceId: string;
  elapsedMs?: number;
  failed: boolean;
  timedOut?: boolean;
}

export function recordMangaSourceHealth(
  entries: MangaSourceHealthEntry[]
): HealthMap {
  if (typeof window === 'undefined' || entries.length === 0) return {};

  const next = readMangaSourceHealth();
  const measuredAt = Date.now();
  for (const entry of entries) {
    if (!entry.sourceId) continue;
    next[entry.sourceId] = {
      failed: entry.failed,
      measuredAt,
      ...(entry.failed && entry.timedOut ? { timedOut: true } : {}),
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
  // 逾時與失效分開講：前者是「這次太慢」，後者是「這個來源不能用」。
  if (health.failed) return health.timedOut ? '逾時' : '失效';
  if (typeof health.elapsedMs !== 'number') return null;
  if (health.elapsedMs < 1500) return `${(health.elapsedMs / 1000).toFixed(1)}s`;
  return `${(health.elapsedMs / 1000).toFixed(1)}s 慢`;
}

/** 選單項目要顯示的狀態；tone 決定顏色，label 是文字 */
export interface MangaSourceStatusLabel {
  label: string;
  tone: 'good' | 'slow' | 'bad';
  /** 資料是管理員測的（authoritative）還是本機被動累積的 */
  source: 'probe' | 'passive';
}

/**
 * 合併「管理員測試快取」與「本機被動量測」，給選源選單一個標籤。
 *
 * 優先用 probe：那是管理員明確測出來的、全站共用的結果，且對「這顆能不能用」
 * 的判斷比被動量測可靠 —— 被動量測只在使用者剛好搜過那顆來源時才有資料。
 * probe 沒有該來源時才退回被動量測，這樣新啟用、還沒測過的來源仍能顯示
 * 使用者自己搜出來的速度。
 *
 * `capability` 決定看哪一種能力：推薦頁該看熱門、搜尋頁該看搜尋。
 * 混用會誤導 —— 實測有來源熱門正常卻搜不到，反之亦然。
 */
export function formatMangaSourceStatus(
  probe: MangaSourceProbeSummary | undefined,
  health: MangaSourceHealth | undefined,
  capability: 'popular' | 'search'
): MangaSourceStatusLabel | null {
  if (probe) {
    const ok = capability === 'popular' ? probe.popularOk : probe.searchOk;
    const ms = capability === 'popular' ? probe.popularMs : probe.searchMs;
    if (!ok) return { label: '失效', tone: 'bad', source: 'probe' };
    return {
      label: ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`,
      tone: ms < 1500 ? 'good' : 'slow',
      source: 'probe',
    };
  }

  const passive = formatMangaSourceHealth(health);
  if (!passive) return null;
  return {
    label: passive,
    tone: health?.failed ? (health.timedOut ? 'slow' : 'bad') : 'good',
    source: 'passive',
  };
}
