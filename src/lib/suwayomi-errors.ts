export function isSuwayomiUnknownFieldError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FieldUndefined|Unknown field|Cannot query field/i.test(message);
}

/**
 * 來源被管理員停用／不在允許清單內。與「上游掛掉」區分，讓 route 回 403 而非 500。
 */
export class MangaSourceForbiddenError extends Error {
  constructor(message = '所选来源不可用或已被管理员停用') {
    super(message);
    this.name = 'MangaSourceForbiddenError';
  }
}

export function isMangaSourceForbiddenError(error: unknown): boolean {
  return error instanceof MangaSourceForbiddenError;
}
