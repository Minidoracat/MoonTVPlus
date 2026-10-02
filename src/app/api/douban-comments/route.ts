/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import {
  doubanCooldownSeconds,
  GATE_SATURATED_RETRY_SECONDS,
  isDoubanBlocked,
} from '@/lib/douban-anti-crawler';
import {
  ensureDoubanComments,
  fetchDoubanCommentPage,
  getDoubanCommentStore,
} from '@/lib/douban-comments';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const doubanId = searchParams.get('id');
  const start = Math.max(0, parseInt(searchParams.get('start') || '0', 10) || 0);
  const limit = Math.min(
    50,
    Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20)
  );

  if (!doubanId || !/^\d+$/.test(doubanId)) {
    return NextResponse.json({ error: 'Missing douban ID' }, { status: 400 });
  }

  const store = getDoubanCommentStore();
  if (!store) {
    return passthrough(doubanId, start, limit);
  }

  try {
    // 前端 start 是本地列表的 offset；向豆瓣抓取的游标由 meta.nextStart 单独维护
    const meta = await ensureDoubanComments(doubanId, start + limit, start === 0);
    // 从未成功抓取过（本地为空且被拒/受阻）→ 明确报错让前端给重试入口；已有本地数据则降级只回本地
    // Retry-After：全局冷却 → 剩余秒数（429）；该片罚期仍有效 → 剩余秒数；否则（无 meta 或罚期已过 = 本次被闸门饱和挡下）→ 30s
    if (!meta || (meta.count === 0 && meta.fetchedAt === 0)) {
      const cooldown = doubanCooldownSeconds();
      const penalty = meta ? Math.ceil((meta.retryAfter - Date.now()) / 1000) : 0;
      const retryAfter =
        cooldown > 0 ? cooldown : penalty > 0 ? penalty : GATE_SATURATED_RETRY_SECONDS;
      return NextResponse.json(
        { error: 'Failed to fetch douban page' },
        { status: cooldown > 0 ? 429 : 503, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
    const { comments } = await store.getDoubanCommentPage(doubanId, start, limit);
    const canFetchMore =
      !meta.exhausted && meta.retryAfter <= Date.now() && !isDoubanBlocked();

    return NextResponse.json(
      {
        comments,
        total: Math.max(meta.count, meta.total),
        start,
        limit,
        hasMore: start + comments.length < meta.count || canFetchMore,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Douban comments fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to load douban comments' },
      { status: 500 }
    );
  }
}

/**
 * 存储后端不支持落地（SQL / localstorage）时的原始行为：每次直连豆瓣，语义与旧实现一致
 */
async function passthrough(doubanId: string, start: number, limit: number) {
  const page = await fetchDoubanCommentPage(doubanId, start, limit);
  if ('status' in page) {
    return NextResponse.json(
      { error: 'Failed to fetch douban page' },
      {
        status: page.status >= 400 && page.status < 600 ? page.status : 503,
        headers: page.retryAfter ? { 'Retry-After': page.retryAfter } : undefined,
      }
    );
  }
  const { comments } = page;
  // 旧实现：页面没给总数时，用 start+本页数估计；满页则 +1 表示"可能还有"
  let total = page.total;
  if (total === 0 && comments.length > 0) {
    total = start + comments.length + (comments.length >= limit ? 1 : 0);
  }
  return NextResponse.json(
    {
      comments,
      total,
      start,
      limit,
      hasMore:
        total > 0 ? start + comments.length < total : comments.length >= limit,
    },
    { headers: { 'Cache-Control': 'public, max-age=600, s-maxage=600' } }
  );
}
