import { NextRequest, NextResponse } from 'next/server';

import { parseMangaFilterSelections } from '@/lib/manga-filter-params';
import { MangaRecommendType } from '@/lib/manga.types';
import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';

/**
 * 源內搜尋關鍵字的長度上限。
 *
 * 關鍵字會原樣送給上游來源，不設限等於讓任何登入者拿我們的伺服器
 * 對漫畫站發任意長度的查詢。200 對真實書名已非常寬鬆。
 */
const MAX_KEYWORD_LENGTH = 200;

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const { searchParams } = new URL(request.url);
    const sourceId = searchParams.get('sourceId')?.trim();
    const page = Number(searchParams.get('page') || '1');
    const typeParam = searchParams.get('type')?.trim().toUpperCase();
    const type: MangaRecommendType = typeParam === 'LATEST' ? 'LATEST' : 'POPULAR';
    const keyword = searchParams.get('q')?.trim() || '';

    if (!sourceId) {
      return NextResponse.json({ mangas: [], hasNextPage: false });
    }

    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
    }

    const filters = parseMangaFilterSelections(searchParams.get('filters'));
    if (filters === null) {
      return NextResponse.json(
        { error: 'filters 参数格式无效' },
        { status: 400 }
      );
    }

    const result = await suwayomiClient.getRecommendedManga(
      sourceId,
      type,
      page,
      filters,
      keyword
    );
    return NextResponse.json(result);
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
