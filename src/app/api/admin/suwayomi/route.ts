import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { SuwayomiClient } from '@/lib/suwayomi.client';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const username = authInfo.username;
    if (username !== process.env.USERNAME) {
      const userInfo = await db.getUserInfoV2(username);
      if (!userInfo || userInfo.role !== 'admin' || userInfo.banned) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }

    const body = await request.json();
    const {
      ServerURL,
      AuthMode,
      Username,
      Password,
      DefaultLang,
    } = body as {
      ServerURL?: string;
      AuthMode?: 'none' | 'basic_auth' | 'simple_login';
      Username?: string;
      Password?: string;
      DefaultLang?: string;
    };

    if (!ServerURL?.trim()) {
      return NextResponse.json({ success: false, message: '请先填写 Suwayomi 服务地址' }, { status: 400 });
    }

    if ((AuthMode === 'basic_auth' || AuthMode === 'simple_login') && (!Username?.trim() || !Password)) {
      return NextResponse.json({ success: false, message: '当前认证方式需要填写用户名和密码' }, { status: 400 });
    }

    const client = new SuwayomiClient({
      serverUrl: ServerURL.trim(),
      authMode: AuthMode || 'none',
      username: Username?.trim(),
      password: Password,
    });

    // 用不套政策的版本：這是「測試這台 Suwayomi 通不通」的診斷動作。
    // getSources() 會套目前儲存設定的白／黑名單，並在設定讀取降級時
    // fail closed —— 兩者都會讓管理員在最需要診斷時測不了連線，
    // 而且會用舊 server 的 SourceIds 去過濾新 server 的來源，誤報 0 個。
    const sources = await client.getSourcesForAdmin(
      (DefaultLang || 'zh').trim() || 'zh'
    );

    return NextResponse.json({
      success: true,
      message: `连接成功，当前语言下检测到 ${sources.length} 个源`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : '测试连接失败',
      },
      { status: 400 }
    );
  }
}
