import { NextRequest, NextResponse } from 'next/server';

import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
  }

  const rawItems =
    body && typeof body === 'object'
      ? (body as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(rawItems) || rawItems.length > 30) {
    return NextResponse.json({ error: 'items 参数无效' }, { status: 400 });
  }

  const items: Array<{ sourceId: string; mangaId: string }> = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') {
      return NextResponse.json({ error: 'items 参数无效' }, { status: 400 });
    }
    const { sourceId, mangaId } = item as {
      sourceId?: unknown;
      mangaId?: unknown;
    };
    if (
      typeof sourceId !== 'string' ||
      !sourceId.trim() ||
      typeof mangaId !== 'string' ||
      !mangaId.trim()
    ) {
      return NextResponse.json({ error: 'items 参数无效' }, { status: 400 });
    }
    items.push({ sourceId: sourceId.trim(), mangaId: mangaId.trim() });
  }

  try {
    const summaries = await suwayomiClient.getChapterSummaries(items);
    return NextResponse.json({ summaries });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
