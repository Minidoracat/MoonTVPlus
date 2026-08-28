/**
 * 解析搜尋來源參數。
 * 同時接受舊的 `sourceId=a`（單值）與新的 `sourceIds=a,b,c`（多值）；
 * 兩者皆空代表「全部來源」，由 getSearchSources 套用 MaxSources 上限。
 */
export function parseMangaSourceIds(searchParams: URLSearchParams): string[] {
  const raw = [
    ...searchParams.getAll('sourceIds'),
    ...searchParams.getAll('sourceId'),
  ];

  const seen = new Set<string>();
  for (const entry of raw) {
    for (const piece of entry.split(',')) {
      const id = piece.trim();
      if (id) seen.add(id);
    }
  }

  return Array.from(seen);
}

/**
 * 搜尋關鍵字長度上限。
 *
 * 關鍵字會原樣進 GraphQL variables 送給來源，而 `/api/manga/search` 是對
 * **所有**啟用來源 fan-out（實測 51 顆），放大倍率遠高於單源的 recommend。
 * 200 個 UTF-16 code unit 對搜尋詞足夠，對 astral 字元反而更嚴。
 */
export const MAX_KEYWORD_LENGTH = 200;

/**
 * 分頁上限。存在的理由是不讓極大整數原樣送進上游 GraphQL；
 * 來源的實際頁數遠低於此（實測 page=10000 時上游自己就回 hasNextPage: false）。
 */
export const MAX_PAGE = 10000;

/**
 * `page` 的解析結果。
 *
 * 刻意分成 `invalid` 與 `exhausted` 兩種失敗：前者是呼叫端給了壞格式
 * （NaN、負數、小數、0），該回 400；後者是「超出我們願意轉發的頁數」，
 * 對呼叫端等同「沒有更多了」，該回空結果 —— 回 400 會讓前端的載入更多
 * 陷入「哨兵仍在視窗內 → 重新 observe → 再打 → 再 400」的迴圈。
 */
export type ParsedMangaPage =
  | { ok: true; page: number }
  | { ok: false; reason: 'invalid' | 'exhausted' };

/**
 * 解析並驗證 `page` 參數。
 *
 * 抽成共用函式是因為這條規則先前只寫在 recommend route 裡，
 * `/api/manga/search` 與 `/api/manga/search/ws` 都漏掉，
 * 而後兩者是對所有來源 fan-out，畸形 page 的放大倍率更高。
 */
export function parseMangaPage(raw: string | null): ParsedMangaPage {
  // page 會直接進 GraphQL variables：NaN 經 JSON.stringify 變成 null，
  // 負數與浮點數則原樣送給來源，都是上游無從處理的輸入。
  const value = Number(raw || '1');
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (value > MAX_PAGE) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, page: value };
}
