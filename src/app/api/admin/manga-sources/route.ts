/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import type { AdminConfig } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  getConfig,
  isDegradedConfigObject,
  setCachedConfig,
} from '@/lib/config';
import { db } from '@/lib/db';
import {
  isMangaSourceAllowed,
  MANGA_DISABLE_ALL_SENTINEL,
} from '@/lib/manga.types';
import { suwayomiClient } from '@/lib/suwayomi.client';

export const runtime = 'nodejs';

/** 單次測試的併發上限：避免一次對十幾個漫畫站同時發請求 */
const PROBE_CONCURRENCY = 4;

export interface MangaSourceProbeResult {
  sourceId: string;
  ok: boolean;
  elapsedMs: number;
  count: number;
  error?: string;
  testedAt: number;
}

/**
 * 最近一次測試結果，per-process 記憶體快取。
 *
 * 刻意不落 DB：這是診斷資料而非設定，重啟後顯示「未測試」比顯示過期的
 * 綠燈誠實。管理員按一次「測試」就會重新填滿。
 */
const probeResults = new Map<string, MangaSourceProbeResult>();

async function requireAdmin(
  request: NextRequest
): Promise<string | NextResponse> {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;
  if (username !== process.env.USERNAME) {
    const userInfo = await db.getUserInfoV2(username);
    // 必須同時接受 owner：/api/admin/config 與 MangaLayout 的入口判斷都是
    // owner || admin，若這裡只收 admin，非 process.env.USERNAME 的站長
    // 會看得到「源管理」按鈕但每個動作都回 401。
    const role = userInfo?.role;
    if (!userInfo || (role !== 'admin' && role !== 'owner') || userInfo.banned) {
      return NextResponse.json({ error: '权限不足' }, { status: 401 });
    }
  }
  return username;
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  try {
    const config = await getConfig();
    // 帶 lang=undefined 取全部語言，管理面板要能看到／啟用其他語言的來源
    const sources = await suwayomiClient.getSourcesForAdmin();
    const allIds = sources.map((item) => item.id);
    const allowList = config.SuwayomiConfig?.SourceIds || [];
    const blockList = config.SuwayomiConfig?.DisabledSourceIds || [];

    return NextResponse.json({
      restricted: allowList.length > 0 || blockList.length > 0,
      maxSources: config.SuwayomiConfig?.MaxSources || 10,
      sources: sources.map((item) => ({
        id: item.id,
        name: item.name,
        displayName: item.displayName,
        lang: item.lang,
        contentWarning: item.contentWarning,
        enabled: isMangaSourceAllowed(item.id, allowList, blockList),
        probe: probeResults.get(item.id) || null,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '读取漫画源失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  try {
    const body = (await request.json()) as {
      action?: 'enable' | 'disable' | 'enable_all' | 'disable_all' | 'test';
      sourceId?: string;
      sourceIds?: string[];
    };
    const action = body.action;
    if (
      !action ||
      !['enable', 'disable', 'enable_all', 'disable_all', 'test'].includes(action)
    ) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    const sources = await suwayomiClient.getSourcesForAdmin();
    const allIds = sources.map((item) => item.id);

    if (action === 'test') {
      const targets =
        body.sourceIds && body.sourceIds.length > 0
          ? body.sourceIds.filter((id) => allIds.includes(id))
          : allIds;
      if (targets.length === 0) {
        return NextResponse.json({ results: [] });
      }

      const results: MangaSourceProbeResult[] = [];
      // 分批跑，避免一次打爆上游
      for (let i = 0; i < targets.length; i += PROBE_CONCURRENCY) {
        const batch = targets.slice(i, i + PROBE_CONCURRENCY);
        const settled = await Promise.all(
          batch.map(async (sourceId) => {
            const probe = await suwayomiClient.probeSource(sourceId);
            const entry: MangaSourceProbeResult = {
              sourceId,
              ...probe,
              testedAt: Date.now(),
            };
            probeResults.set(sourceId, entry);
            return entry;
          })
        );
        results.push(...settled);
      }
      return NextResponse.json({ results });
    }

    // 以下是寫入設定的動作。
    // 判斷綁在「即將寫回的那份設定物件」上，不讀全域旗標（會被並發請求翻掉）。
    const config = await getConfig();
    if (isDegradedConfigObject(config)) {
      // 這份是讀不到真實設定時的臨時預設值，寫回去會覆蓋掉真正的設定
      return NextResponse.json(
        { error: '当前无法读取管理配置，暂时不能修改来源开关' },
        { status: 503 }
      );
    }
    if (!config.SuwayomiConfig) {
      return NextResponse.json(
        { error: '请先在上方完成 Suwayomi 配置' },
        { status: 400 }
      );
    }

    // allIds 是 Suwayomi 這一瞬間回報的清單。
    // `disable_all` 只寫哨兵、不需要知道完整目錄，所以空清單時仍應放行 ——
    // 那正是上游異常時管理員最需要的緊急全關。其餘動作要看得到目錄才安全。
    if (allIds.length === 0 && action !== 'disable_all') {
      return NextResponse.json(
        { error: '暂时无法取得来源列表，请稍后再试' },
        { status: 503 }
      );
    }

    // getConfig() 回的是 module 級 cachedConfig 的同一個參考。直接就地改它
    // 等於「還沒持久化就先對所有讀取路徑生效」：若接下來 saveAdminConfig
    // 失敗，面板會回滾顯示但記憶體裡已經放寬了。所以先深拷貝再改，
    // 存檔成功後才用 setCachedConfig 發布。
    const next: AdminConfig = JSON.parse(JSON.stringify(config));
    if (!next.SuwayomiConfig) {
      return NextResponse.json(
        { error: '请先在上方完成 Suwayomi 配置' },
        { status: 400 }
      );
    }

    const allowList = next.SuwayomiConfig.SourceIds || [];
    const blockList = new Set(next.SuwayomiConfig.DisabledSourceIds || []);

    if (action === 'enable_all') {
      // 全開＝白名單不限制、黑名單清空
      next.SuwayomiConfig.SourceIds = [];
      next.SuwayomiConfig.DisabledSourceIds = [];
    } else if (action === 'disable_all') {
      // 全關無法用黑名單表達（那需要列出完整目錄），用白名單哨兵
      next.SuwayomiConfig.SourceIds = [MANGA_DISABLE_ALL_SENTINEL];
      next.SuwayomiConfig.DisabledSourceIds = [];
    } else {
      const sourceId = body.sourceId?.trim();
      if (!sourceId || !allIds.includes(sourceId)) {
        return NextResponse.json({ error: '来源不存在' }, { status: 400 });
      }

      // 單顆切換只動黑名單 —— 絕不把「目前回報的清單」具體化成白名單。
      // 上游重啟／擴充套件重載期間只會列出部分來源，具體化會把所有當下
      // 沒回報的來源一起意外停用。黑名單是減法，不需要知道完整目錄。
      if (action === 'enable') {
        blockList.delete(sourceId);
        // 若原本是「全關哨兵」，啟用一顆就得改成明確白名單
        if (allowList.includes(MANGA_DISABLE_ALL_SENTINEL)) {
          next.SuwayomiConfig.SourceIds = [sourceId];
        } else if (allowList.length > 0 && !allowList.includes(sourceId)) {
          next.SuwayomiConfig.SourceIds = [...allowList, sourceId];
        }
      } else {
        blockList.add(sourceId);
      }
      next.SuwayomiConfig.DisabledSourceIds = Array.from(blockList);
    }

    // 先落 DB，成功後才發布到記憶體快取
    await db.saveAdminConfig(next);
    await setCachedConfig(next);

    const finalAllow = next.SuwayomiConfig.SourceIds || [];
    const finalBlock = next.SuwayomiConfig.DisabledSourceIds || [];
    return NextResponse.json({
      restricted: finalAllow.length > 0 || finalBlock.length > 0,
      enabledIds: allIds.filter((id) =>
        isMangaSourceAllowed(id, finalAllow, finalBlock)
      ),
    });
  } catch (error) {
    console.error('漫画源管理操作失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '操作失败' },
      { status: 500 }
    );
  }
}
