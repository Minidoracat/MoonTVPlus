/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig, isConfigDegraded } from '@/lib/config';
import { db } from '@/lib/db';
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
    if (!userInfo || userInfo.role !== 'admin' || userInfo.banned) {
      return NextResponse.json({ error: '权限不足' }, { status: 401 });
    }
  }
  return username;
}

/**
 * 「全部停用」用的哨兵值。
 *
 * `SourceIds: []` 在全站語意是「不限制＝全開」，所以全停時不能寫回空陣列，
 * 否則管理員按「全部停用」會得到「全部開放」。寫入一個不可能對到任何來源的
 * 值，`getSources()` 的 `sourceIds.includes(id)` 過濾後自然是空清單＝全部拒絕。
 * Suwayomi 的 source id 是數字字串，不會與這個值相撞。
 */
const DISABLE_ALL_SENTINEL = '__none__';

/**
 * SourceIds 為空代表「不限制」，所以停用單一來源時必須先把目前可用清單
 * 具體化，再移除該項；否則寫回空陣列會變成「全部開放」。
 */
function computeEnabledIds(
  allIds: string[],
  configured: string[] | undefined
): Set<string> {
  const list = configured && configured.length > 0 ? configured : allIds;
  return new Set(list.filter((id) => allIds.includes(id)));
}

function serializeAllowList(allIds: string[], enabled: Set<string>): string[] {
  // 全開時寫回空陣列，保持與「未設定」語意一致，也讓之後新增的來源預設可用
  if (allIds.length > 0 && allIds.every((id) => enabled.has(id))) return [];
  // 全停：空陣列會被當成不限制，必須用哨兵
  if (enabled.size === 0) return [DISABLE_ALL_SENTINEL];
  return allIds.filter((id) => enabled.has(id));
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  try {
    const config = await getConfig();
    // 帶 lang=undefined 取全部語言，管理面板要能看到／啟用其他語言的來源
    const sources = await suwayomiClient.getSourcesForAdmin();
    const allIds = sources.map((item) => item.id);
    const enabled = computeEnabledIds(
      allIds,
      config.SuwayomiConfig?.SourceIds
    );

    return NextResponse.json({
      restricted: (config.SuwayomiConfig?.SourceIds || []).length > 0,
      maxSources: config.SuwayomiConfig?.MaxSources || 10,
      sources: sources.map((item) => ({
        id: item.id,
        name: item.name,
        displayName: item.displayName,
        lang: item.lang,
        contentWarning: item.contentWarning,
        enabled: enabled.has(item.id),
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

    // 以下是寫入設定的動作
    if (isConfigDegraded()) {
      // 讀不到真實設定時寫回去會覆蓋成臨時預設值
      return NextResponse.json(
        { error: '当前无法读取管理配置，暂时不能修改来源开关' },
        { status: 503 }
      );
    }

    const config = await getConfig();
    if (!config.SuwayomiConfig) {
      return NextResponse.json(
        { error: '请先在上方完成 Suwayomi 配置' },
        { status: 400 }
      );
    }

    const enabled = computeEnabledIds(allIds, config.SuwayomiConfig.SourceIds);

    if (action === 'enable_all') {
      allIds.forEach((id) => enabled.add(id));
    } else if (action === 'disable_all') {
      enabled.clear();
    } else {
      const sourceId = body.sourceId?.trim();
      if (!sourceId || !allIds.includes(sourceId)) {
        return NextResponse.json({ error: '来源不存在' }, { status: 400 });
      }
      if (action === 'enable') enabled.add(sourceId);
      else enabled.delete(sourceId);
    }

    config.SuwayomiConfig.SourceIds = serializeAllowList(allIds, enabled);
    await db.saveAdminConfig(config);

    return NextResponse.json({
      restricted: config.SuwayomiConfig.SourceIds.length > 0,
      enabledIds: allIds.filter((id) => enabled.has(id)),
    });
  } catch (error) {
    console.error('漫画源管理操作失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '操作失败' },
      { status: 500 }
    );
  }
}
