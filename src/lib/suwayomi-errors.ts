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

/**
 * 使用者已被開放成人源、但開著安全模式時被擋。照樣是 403，
 * 多帶 code 讓前端顯示「關閉安全模式」，而不是一般的「來源不可用」。
 * 沒被開放的人一律拿 MangaSourceForbiddenError，看不出那是成人源。
 */
export class MangaSafeModeError extends MangaSourceForbiddenError {
  readonly code = 'safe_mode';
  constructor() {
    super('这部漫画在安全模式下不显示');
    this.name = 'MangaSafeModeError';
  }
}
