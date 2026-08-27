import { NextRequest, NextResponse } from 'next/server';

import { parseMangaSourceIds } from '@/lib/manga-search-params';
import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    const sourceIds = parseMangaSourceIds(searchParams);
    const page = Number(searchParams.get('page') || '1');

    if (!q) {
      return NextResponse.json({ results: [] });
    }

    const result = await suwayomiClient.searchManga(q, sourceIds, page);
    return NextResponse.json({
      ...result,
      // 與 SSE 版一致：只有「每個查詢的來源都失敗」才算全滅。
      // 來源成功但回 0 筆是合法空結果，不可算失敗。
      allFailed:
        result.attemptedSources > 0 &&
        result.failedSources.length === result.attemptedSources,
    });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
