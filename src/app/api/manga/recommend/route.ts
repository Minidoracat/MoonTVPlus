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
/**
 * 分頁上限。漫畫來源的實際頁數遠低於此，這個值只是為了讓極大整數
 * 不會原樣送進上游 GraphQL。
 */
const MAX_PAGE = 10000;

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const { searchParams } = new URL(request.url);
    const sourceId = searchParams.get('sourceId')?.trim();
    const pageParam = Number(searchParams.get('page') || '1');
    const typeParam = searchParams.get('type')?.trim().toUpperCase();
    const type: MangaRecommendType = typeParam === 'LATEST' ? 'LATEST' : 'POPULAR';
    const keyword = searchParams.get('q')?.trim() || '';

    if (!sourceId) {
      return NextResponse.json({ mangas: [], hasNextPage: false });
    }

    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
    }

    // page 會直接進 GraphQL variables：NaN 經 JSON.stringify 變成 null，
    // 負數／浮點數／極大整數則原樣送給來源，都是上游無從處理的輸入。
    if (!Number.isInteger(pageParam) || pageParam < 1 || pageParam > MAX_PAGE) {
      return NextResponse.json({ error: 'page 参数无效' }, { status: 400 });
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
      pageParam,
      filters,
      keyword
    );
    return NextResponse.json(result);
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
