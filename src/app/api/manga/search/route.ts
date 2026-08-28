import { NextRequest, NextResponse } from 'next/server';

import {
  MAX_KEYWORD_LENGTH,
  parseMangaPage,
  parseMangaSourceIds,
} from '@/lib/manga-search-params';
import { isAllMangaSourcesFailed } from '@/lib/manga.types';
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
    const parsedPage = parseMangaPage(searchParams.get('page'));

    /*
     * 格式驗證要排在語意性早退（`!q`）之前，否則回應碼會取決於一個無關的
     * 參數 —— recommend route 就踩過這個坑（帶不帶 sourceId 決定同一組
     * 畸形參數回 400 還是 200）。
     *
     * 這條路徑的放大倍率比 recommend 高：searchManga 會對**所有**啟用來源
     * fan-out（實測 51 顆），一個畸形 page 或超長關鍵字會變成 51 次對外請求。
     */
    if (q && q.length > MAX_KEYWORD_LENGTH) {
      return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
    }
    if (!parsedPage.ok && parsedPage.reason === 'invalid') {
      return NextResponse.json({ error: 'page 参数无效' }, { status: 400 });
    }

    if (!q) {
      return NextResponse.json({ results: [] });
    }
    if (!parsedPage.ok) {
      // reason === 'exhausted'：超出願意轉發的頁數，等同沒有結果了
      return NextResponse.json({ results: [] });
    }

    const result = await suwayomiClient.searchManga(q, sourceIds, parsedPage.page);
    return NextResponse.json({
      ...result,
      allFailed: isAllMangaSourcesFailed(
        result.attemptedSources,
        result.failedSources.length
      ),
    });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
