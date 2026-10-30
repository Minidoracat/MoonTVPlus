import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import { isAdultSourceName } from '@/lib/manga.types';
import { getMangaAdultView } from '@/lib/permissions';
import { suwayomiClient } from '@/lib/suwayomi.client';

export const runtime = 'nodejs';

// GET: 获取所有通知
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const storage = getStorage();
    let notifications = await storage.getNotifications(authInfo.username);
    let unreadCount = await storage.getUnreadNotificationCount(authInfo.username);

    // 漫畫更新通知帶著書名與封面：沒開放或開著安全模式的人看不到成人源的那幾則。
    // 成人源 id 取不到時略過全部漫畫更新，而不是讓整個通知列表失敗。
    // 這支會被輪詢，沒有漫畫更新通知就不查權限與來源。
    if (
      notifications.some((item) => item.type === 'manga_update') &&
      (await getMangaAdultView(authInfo.username)) !== 'shown'
    ) {
      const adultIds = await suwayomiClient.getAdultSourceIds().catch((error) => {
        console.error('获取成人漫画源失败:', error);
        return null;
      });
      const hidden = new Set(
        notifications.filter(
          (item) =>
            item.type === 'manga_update' &&
            (!adultIds ||
              adultIds.has(String(item.metadata?.sourceId)) ||
              isAdultSourceName(item.metadata?.sourceName))
        )
      );
      notifications = notifications.filter((item) => !hidden.has(item));
      unreadCount = Math.max(
        0,
        unreadCount - Array.from(hidden).filter((item) => !item.read).length
      );
    }

    return NextResponse.json({
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error('获取通知失败:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}

// POST: 标记通知为已读或删除通知
export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { action, notificationId } = body;

    const storage = getStorage();

    if (action === 'mark_read' && notificationId) {
      await storage.markNotificationAsRead(authInfo.username, notificationId);
      return NextResponse.json({ message: '已标记为已读' });
    }

    if (action === 'delete' && notificationId) {
      await storage.deleteNotification(authInfo.username, notificationId);
      return NextResponse.json({ message: '已删除' });
    }

    if (action === 'clear_all') {
      await storage.clearAllNotifications(authInfo.username);
      return NextResponse.json({ message: '已清空所有通知' });
    }

    return NextResponse.json({ error: '无效的操作' }, { status: 400 });
  } catch (error) {
    console.error('操作通知失败:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
