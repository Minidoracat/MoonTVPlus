import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';

import { getMangaViewer } from '../_utils';

export const runtime = 'nodejs';

/** 安全模式記在帳號上，所有裝置與排程通知一起生效；只有被開放成人源的人能切換 */
export async function PUT(request: NextRequest) {
  // localstorage 模式沒有伺服器端的使用者資料可存，前端也不顯示盾牌
  if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage') {
    return NextResponse.json({ error: '当前存储模式不支持安全模式' }, { status: 400 });
  }
  const viewer = await getMangaViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (viewer.adult === 'none') {
    return NextResponse.json({ error: '无权限' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
  }
  const enabled =
    body && typeof body === 'object' && 'enabled' in body ? body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled 参数无效' }, { status: 400 });
  }

  await db.updateUserInfoV2(viewer.username, { mangaSafeMode: enabled });
  return NextResponse.json({ adult: enabled ? 'hidden' : 'shown' });
}
