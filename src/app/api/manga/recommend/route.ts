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
 * 分頁上限。存在的理由是不讓極大整數原樣送進上游 GraphQL；
 * 漫畫來源的實際頁數遠低於此。
 *
 * 超過上限**不是** 400 ——「超出我們願意轉發的頁數」對呼叫端來說等同
 * 「沒有更多了」。回 400 會讓前端的載入更多陷入「哨兵仍在視窗內 →
 * 重新 observe → 再打 → 再 400」的迴圈；回空結果 + hasNextPage: false
 * 才會讓它自然停下。真正格式無效的 page（NaN、負數、小數）仍回 400。
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
    // 負數與浮點數則原樣送給來源，都是上游無從處理的輸入。
    if (!Number.isInteger(pageParam) || pageParam < 1) {
      return NextResponse.json({ error: 'page 参数无效' }, { status: 400 });
    }
    // 見 MAX_PAGE 的註解：這是「沒有更多」，不是呼叫端的錯。
    if (pageParam > MAX_PAGE) {
      return NextResponse.json({ mangas: [], hasNextPage: false });
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
