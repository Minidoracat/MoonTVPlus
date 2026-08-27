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
