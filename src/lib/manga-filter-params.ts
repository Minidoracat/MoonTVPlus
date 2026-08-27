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
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** 單一群組內最多允許勾選幾項；防止惡意 payload 塞爆上游 */
export const MAX_GROUP_SELECTIONS = 200;

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
          value < 0
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
