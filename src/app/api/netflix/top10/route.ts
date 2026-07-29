/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import {
  getNetflixTop10Rows,
  normalizeRegion,
  resolveTudumRows,
} from '@/lib/netflix-top10';

export const runtime = 'nodejs';
// 必须：build 期 localstorage 模式下 db 会 throw，不可被预渲染
export const dynamic = 'force-dynamic';

// 刻意不做 route 层回应快取：真正贵的两段都已经各自有快取
//（周快照走 memWeeks，片名映射走 titleCache 7 天），
// 而以 region:kind:week 为键、week 为空代表「最新一周」的快取会在 cron 抓到新一周后
// 继续吐旧周资料与旧的 weeks/regions 清单，最长 6 小时。省下的那点开销不值这个陈旧风险。

/**
 * GET /api/netflix/top10?region=TW&kind=films|tv&week=YYYY-MM-DD
 * Netflix 官方 Top 10 周榜，返回豆瓣风格列表 + 可选周次
 */
export async function GET(request: NextRequest) {
  // middleware 的 matcher 是负向排除清单，本路径已被拦；
  // 但 localstorage 模式下 middleware 只比对密码，不保证 username 存在
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const region = normalizeRegion(searchParams.get('region'));
  const kind = searchParams.get('kind') === 'tv' ? 'tv' : 'films';
  const weekParam = searchParams.get('week') || '';
  // 非法周次一律丢弃回落最新周，不让任意字串进 KV key
  const week = /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : '';

  const empty = { list: [], week: '', weeks: [] as string[] };

  // 官方资料只有英文片名、无海报无 ID，中文化与海报必须靠 TMDB
  const config = await getConfig();
  // trim 与 server-config route 的 TMDBEnabled 判断一致，避免「UI 藏起入口但 route 认为有 key」
  const apiKey = (config.SiteConfig.TMDBApiKey || '').trim();
  if (!apiKey) {
    return NextResponse.json({
      code: 400,
      message: '未配置 TMDB API Key',
      ...empty,
    });
  }


  try {
    const {
      rows,
      week: actualWeek,
      weeks,
      regions,
      pending,
    } = await getNetflixTop10Rows({
      region,
      kind,
      week: week || undefined,
    });

    if (pending) {
      // 冷启动：getNetflixTop10Rows 内部已 fire-and-forget 触发 ingest，
      // 这里绝不 await 那 31MB（首轮约 40 秒会把请求卡死）。不快取，前端稍后重试
      return NextResponse.json({
        code: 200,
        message: '数据准备中，请稍后重试',
        ...empty,
        pending: true,
      });
    }

    const list = await resolveTudumRows(
      rows,
      kind,
      apiKey,
      config.SiteConfig.TMDBProxy,
      config.SiteConfig.TMDBReverseProxy
    );

    const result = {
      code: 200,
      message: '获取成功',
      list,
      week: actualWeek,
      weeks,
      regions,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error(
      '获取 Netflix Top10 失败:',
      (error as Error)?.message || error
    );
    // HTTP 恒 200、错误装在 body 的 code：page.tsx:418/432 是
    // `if (data.code === 200) ... else throw new Error(data.message)`
    return NextResponse.json({
      code: 500,
      message: '获取 Netflix Top10 失败',
      ...empty,
    });
  }
}
