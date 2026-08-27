/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfigResult } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig, isDegradedConfigObject } from '@/lib/config';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    const config = await getConfig();
    const result: AdminConfigResult = {
      Role: 'owner',
      Config: config,
    };
    if (username === process.env.USERNAME) {
      result.Role = 'owner';
    } else {
      // 从新版数据库获取用户信息
      const { db } = await import('@/lib/db');
      const userInfoV2 = await db.getUserInfoV2(username);

      if (userInfoV2 && userInfoV2.role === 'admin' && !userInfoV2.banned) {
        result.Role = 'admin';
      } else {
        return NextResponse.json(
          { error: '你是管理员吗你就访问？' },
          { status: 401 }
        );
      }
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store', // 管理员配置不缓存
      },
    });
  } catch (error) {
    console.error('获取管理员配置失败:', error);
    return NextResponse.json(
      {
        error: '获取管理员配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行管理员配置' },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    const newConfig = await request.json();

    // 权限检查（必須早於任何會觸發 config 初始化的呼叫：
    // 否則一般已登入使用者只要 POST 就能反覆驅動 DB 讀取與訂閱 URL fetch）
    if (username !== process.env.USERNAME) {
      const { db } = await import('@/lib/db');
      const userInfoV2 = await db.getUserInfoV2(username);

      if (!userInfoV2 || (userInfoV2.role !== 'admin' && userInfoV2.role !== 'owner') || userInfoV2.banned) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }

    // SuwayomiConfig.SourceIds（漫畫來源白名單）由 /api/admin/manga-sources
    // 專責維護，面板每次開關都即時寫入。而這個端點收到的是「頁面載入當時」的
    // 整份設定快照 —— 若照抄，管理員在面板停用來源後只要回上面的表單按一次
    // 儲存，白名單就會被舊值靜默還原（已停用的成人來源會重新開放，且沒有任何
    // 錯誤訊息）。因此這裡一律保留 DB 現值，不接受客戶端傳來的 SourceIds。
    if (newConfig?.SuwayomiConfig) {
      const current = await getConfig();
      // getConfig() 在 DB 故障時會回「臨時預設值」（SourceIds 被補成 []）。
      // 若照抄那個值並存回 DB，白名單就被寫成「不限制＝全部開放」，
      // 而下面的 setCachedConfig 還會把降級旗標清掉，連 fail-closed 也解除。
      if (isDegradedConfigObject(current)) {
        return NextResponse.json(
          { error: '当前无法读取管理配置，请稍后再保存' },
          { status: 503 }
        );
      }
      newConfig.SuwayomiConfig.SourceIds =
        current?.SuwayomiConfig?.SourceIds ?? [];
      // 黑名單同樣由面板專責維護，一併保留 DB 現值
      newConfig.SuwayomiConfig.DisabledSourceIds =
        current?.SuwayomiConfig?.DisabledSourceIds ?? [];
    }

    // 保存配置
    const { db } = await import('@/lib/db');
    const { configSelfCheck, setCachedConfig } = await import('@/lib/config');

    // 自检配置
    const checkedConfig = configSelfCheck(newConfig);

    // 保存到数据库
    await db.saveAdminConfig(checkedConfig);

    // 更新缓存
    await setCachedConfig(checkedConfig);

    return NextResponse.json({ success: true, message: '配置已保存' });
  } catch (error) {
    console.error('保存配置失败:', error);
    return NextResponse.json(
      { error: '保存配置失败: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
