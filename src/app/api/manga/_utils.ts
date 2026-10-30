import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { type MangaAdultView, isAdultSourceName } from '@/lib/manga.types';
import { getMangaAdultView, hasFeaturePermission } from '@/lib/permissions';
import { suwayomiClient } from '@/lib/suwayomi.client';
import {
  isMangaSourceForbiddenError,
  MangaSafeModeError,
  MangaSourceForbiddenError,
} from '@/lib/suwayomi-errors';

export async function getMangaViewer(
  request: NextRequest
): Promise<{ username: string; adult: MangaAdultView } | NextResponse> {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (authInfo.username !== process.env.USERNAME) {
    const userInfoV2 = await db.getUserInfoV2(authInfo.username);
    if (!userInfoV2) {
      return NextResponse.json({ error: '用户不存在' }, { status: 401 });
    }
    if (userInfoV2.banned) {
      return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
    }
  }

  const allowed = await hasFeaturePermission(authInfo.username, 'manga');
  if (!allowed) {
    return NextResponse.json({ error: '无权限访问漫画功能' }, { status: 403 });
  }

  return {
    username: authInfo.username,
    adult: await getMangaAdultView(authInfo.username),
  };
}

/**
 * 來源被管理員停用是授權拒絕（403），不是上游故障（500）。
 * 混在一起會讓使用者把政策限制看成系統壞掉，也會污染錯誤告警基線。
 * 安全模式擋下的多帶 code，前端才能顯示「关闭安全模式」而不是一般的拒絕。
 */
export function mangaErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : '请求失败';
  return NextResponse.json(
    error instanceof MangaSafeModeError
      ? { error: message, code: error.code }
      : { error: message },
    { status: isMangaSourceForbiddenError(error) ? 403 : 500 }
  );
}

/**
 * 書架、歷史這類存下來的紀錄只在讀取時略過成人源，不刪資料：
 * 開放或關閉安全模式後原樣回來。成人源 id 取不到時直接丟錯（寧可讀不到也不露出）。
 */
export async function hideAdultRecords<
  T extends { sourceId: string; sourceName?: string }
>(records: Record<string, T>, adult: MangaAdultView): Promise<Record<string, T>> {
  if (adult === 'shown') return records;
  const adultIds = await suwayomiClient.getAdultSourceIds();
  return Object.fromEntries(
    Object.entries(records).filter(
      ([, record]) =>
        !adultIds.has(record.sourceId) && !isAdultSourceName(record.sourceName)
    )
  );
}

/**
 * 書架／歷史寫入前的關卡：成人源只收 shown，拒絕的回應與來源關卡相同。
 * key 與紀錄本身的 sourceId 都是客戶端給的，兩個都要驗。
 */
export async function rejectAdultRecord(
  keySourceId: string,
  record: { sourceId: string; sourceName?: string },
  adult: MangaAdultView
): Promise<NextResponse | null> {
  const checked = {
    key: { sourceId: keySourceId, sourceName: record.sourceName },
    record,
  };
  if (Object.keys(await hideAdultRecords(checked, adult)).length === 2) {
    return null;
  }
  return mangaErrorResponse(
    adult === 'hidden' ? new MangaSafeModeError() : new MangaSourceForbiddenError()
  );
}
