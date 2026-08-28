import type { MangaFilterSelection } from '@/lib/manga.types';

/**
 * 解析並驗證客戶端傳來的 filters 參數（JSON 字串）。
 *
 * 這是不可信輸入：filters 會被原樣轉成 GraphQL 變數送給 Suwayomi，
 * 每一筆的形狀都要驗過，驗不過整包拒絕（回 null → 呼叫端回 400）。
 */

function readNumber(source: object, key: string): number | null {
  if (!(key in source)) return null;
  const value = Reflect.get(source, key);
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_FILTER_INDEX
    ? value
    : null;
}

/** 單一群組內最多允許勾選幾項；防止惡意 payload 塞爆上游 */
export const MAX_GROUP_SELECTIONS = 200;

/**
 * filter 內各種索引（position／innerPosition／index）的上限。
 *
 * 與 recommend route 的 MAX_PAGE 同一個理由：這些數字會原樣進 GraphQL
 * variables 送給來源，沒有上界就能塞到 Number.MAX_SAFE_INTEGER。
 * MAX_FILTER_ENTRIES 只限筆數、不限量級，擋不住這個。
 * 實測最大值：頂層 filter 5 個（喜漫）、群組內 71 項（Komiic）、
 * select 34 個值（喜漫少男漫画），1000 已留足餘裕。
 */
export const MAX_FILTER_INDEX = 1000;

/**
 * 頂層 filter 條目上限。
 *
 * 沒有這個上限時，實際的約束只剩 HTTP 請求行長度 —— 那是隱含防線，
 * 改走 POST body 或放寬反向代理的 buffer 就消失了。實測來源最多 4 個
 * filter（Komiic），50 已留足餘裕。
 */
export const MAX_FILTER_ENTRIES = 50;

/** 回傳 null 代表格式無效（呼叫端應回 400），空陣列代表沒有帶 filters */
export function parseMangaFilterSelections(
  raw: string | null
): MangaFilterSelection[] | null {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length > MAX_FILTER_ENTRIES) return null;

  const out: MangaFilterSelection[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return null;

    const position = readNumber(entry, 'position');
    if (position === null) return null;
    const kind = 'kind' in entry ? Reflect.get(entry, 'kind') : undefined;

    if (kind === 'select' || kind === 'sort') {
      const index = readNumber(entry, 'index');
      if (index === null) return null;
      const ascending =
        'ascending' in entry ? Reflect.get(entry, 'ascending') : undefined;
      if (ascending !== undefined && typeof ascending !== 'boolean') return null;
      out.push(
        kind === 'sort'
          ? {
              position,
              kind,
              index,
              ...(typeof ascending === 'boolean' ? { ascending } : {}),
            }
          : { position, kind, index }
      );
      continue;
    }

    if (kind === 'group_select') {
      const innerPosition = readNumber(entry, 'innerPosition');
      const index = readNumber(entry, 'index');
      if (innerPosition === null || index === null) return null;
      out.push({ position, kind, innerPosition, index });
      continue;
    }

    if (kind === 'group') {
      const rawPositions =
        'positions' in entry ? Reflect.get(entry, 'positions') : undefined;
      if (!Array.isArray(rawPositions) || rawPositions.length === 0) return null;
      if (rawPositions.length > MAX_GROUP_SELECTIONS) return null;
      const positions: number[] = [];
      for (const value of rawPositions) {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > MAX_FILTER_INDEX
        ) {
          return null;
        }
        positions.push(value);
      }
      out.push({ position, kind, positions });
      continue;
    }

    if (kind === 'checkbox') {
      const checked =
        'checked' in entry ? Reflect.get(entry, 'checked') : undefined;
      if (typeof checked !== 'boolean') return null;
      out.push({ position, kind, checked });
      continue;
    }

    return null;
  }
  return out;
}
