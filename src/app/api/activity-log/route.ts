import { NextRequest, NextResponse } from 'next/server';

import { normalizeActivityEvents } from '@/lib/activity-log';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import type { RedisAdapter } from '@/lib/redis-adapter';

export const runtime = 'nodejs';

const MAX_STORED = 20000;

type ListAdapter = Pick<RedisAdapter, 'lPush' | 'lTrim' | 'lRange'>;

// 只有 Redis 類儲存（含 kvrocks）提供 List 操作；比照 refresh-token.ts 做功能偵測
function getListAdapter(): ListAdapter | null {
  // adapter 不在 IStorage 介面上，只能執行期偵測
  const storage: object = getStorage();
  const adapter: Partial<ListAdapter> | undefined =
    'adapter' in storage && storage.adapter && typeof storage.adapter === 'object'
      ? storage.adapter
      : undefined;
  if (
    typeof adapter?.lPush !== 'function' ||
    typeof adapter.lTrim !== 'function' ||
    typeof adapter.lRange !== 'function'
  ) {
    return null;
  }
  return adapter as ListAdapter;
}

const UNSUPPORTED = { error: '目前的儲存後端不支援操作紀錄' };

/**
 * POST /api/activity-log
 * 站長客戶端批次寫入操作紀錄（sendBeacon 只帶 cookie，由 middleware 驗證簽章）
 */
export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username || authInfo.role !== 'owner') {
    return NextResponse.json({ error: '無權限' }, { status: 403 });
  }

  const adapter = getListAdapter();
  if (!adapter) return NextResponse.json(UNSUPPORTED, { status: 501 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const events = normalizeActivityEvents(
    body && typeof body === 'object' && 'events' in body ? body.events : undefined
  );
  if (events.length > 0) {
    const key = `activity_log:${authInfo.username}`;
    await adapter.lPush(key, ...events.map((e) => JSON.stringify(e)));
    await adapter.lTrim(key, 0, MAX_STORED - 1);
  }
  return new NextResponse(null, { status: 204 });
}

/**
 * GET /api/activity-log?limit=500&format=jsonl
 * 站長或管理員讀取，最新的在前
 */
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username || (authInfo.role !== 'owner' && authInfo.role !== 'admin')) {
    return NextResponse.json({ error: '無權限' }, { status: 403 });
  }

  const adapter = getListAdapter();
  if (!adapter) return NextResponse.json(UNSUPPORTED, { status: 501 });

  const { searchParams } = request.nextUrl;
  const parsed = Number.parseInt(searchParams.get('limit') || '', 10);
  const limit = parsed > 0 ? Math.min(parsed, 5000) : 500;

  // 紀錄只寫在站長名下，管理員讀的也是站長的
  const owner = process.env.USERNAME || authInfo.username;
  const lines = await adapter.lRange(`activity_log:${owner}`, 0, limit - 1);

  if (searchParams.get('format') === 'jsonl') {
    return new NextResponse(lines.join('\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } });
}
