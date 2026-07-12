import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getTMDBHotList } from '@/lib/tmdb.client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 榜单高度可缓存（day 至多每日变动、week 每周变动），沿用 trending route 的内存缓存模式
const hotCache = new Map<string, { data: unknown; expires: number }>();
const HOT_CACHE_MAX = 200;
const HOT_CACHE_TTL = {
  day: 30 * 60 * 1000,
  week: 2 * 60 * 60 * 1000,
};

/**
 * GET /api/tmdb/hot?kind=movie|tv&window=day|week&start=0&limit=25
 * TMDB 热门榜单（今日/本周），返回豆瓣风格列表，供分类页数据源切换使用
 */
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const kind = searchParams.get('kind') === 'tv' ? 'tv' : 'movie';
  const timeWindow = searchParams.get('window') === 'week' ? 'week' : 'day';
  // 收敛为有限安全整数，避免 Infinity/NaN 进入分页计算与缓存 key
  const parseIntParam = (value: string | null, fallback: number) => {
    const parsed = Math.trunc(Number(value));
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  };
  // TMDB trending 上限 1000 页 × 20 条
  const start = Math.min(20000, Math.max(0, parseIntParam(searchParams.get('start'), 0)));
  const limit = Math.min(50, Math.max(1, parseIntParam(searchParams.get('limit'), 25)));

  const config = await getConfig();
  const apiKey = config.SiteConfig.TMDBApiKey;
  if (!apiKey) {
    return NextResponse.json({
      code: 400,
      message: '未配置 TMDB API Key',
      list: [],
    });
  }

  const cacheKey = `${kind}:${timeWindow}:${start}:${limit}`;
  const cached = hotCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json(cached.data);
  }

  const result = await getTMDBHotList(
    apiKey,
    kind,
    timeWindow,
    start,
    limit,
    config.SiteConfig.TMDBProxy,
    config.SiteConfig.TMDBReverseProxy
  );

  // 只缓存成功且非空的结果，失败/空结果下次直接重试
  if (result.code === 200 && result.list.length > 0) {
    if (hotCache.size >= HOT_CACHE_MAX) {
      const oldest = hotCache.keys().next().value;
      if (oldest !== undefined) hotCache.delete(oldest);
    }
    hotCache.set(cacheKey, {
      data: result,
      expires: Date.now() + HOT_CACHE_TTL[timeWindow],
    });
  }
  return NextResponse.json(result);
}
