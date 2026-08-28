import { NextRequest, NextResponse } from 'next/server';

import { parseMangaFilterSelections } from '@/lib/manga-filter-params';
import {
  MAX_KEYWORD_LENGTH,
  parseMangaPage,
} from '@/lib/manga-search-params';
import { MangaRecommendType } from '@/lib/manga.types';
import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';


export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const { searchParams } = new URL(request.url);
    const sourceId = searchParams.get('sourceId')?.trim();
    const parsedPage = parseMangaPage(searchParams.get('page'));
    const typeParam = searchParams.get('type')?.trim().toUpperCase();
    const keyword = searchParams.get('q')?.trim() || '';

    /*
     * 明確給了不合法的 type 要回 400，不能靜默 fallback 成 POPULAR。
     * `type=LATSET` 這種拼錯會拿到外觀完全正常、實際排序類型錯誤的資料，
     * 失敗被偽裝成成功。空字串與未提供則視為缺省（與 sourceId 的處理一致）。
     */
    if (typeParam && typeParam !== 'POPULAR' && typeParam !== 'LATEST') {
      return NextResponse.json({ error: 'type 参数无效' }, { status: 400 });
    }
    const type: MangaRecommendType = typeParam === 'LATEST' ? 'LATEST' : 'POPULAR';

    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
    }

    if (!parsedPage.ok && parsedPage.reason === 'invalid') {
      return NextResponse.json({ error: 'page 参数无效' }, { status: 400 });
    }

    const filters = parseMangaFilterSelections(searchParams.get('filters'));
    if (filters === null) {
      return NextResponse.json(
        { error: 'filters 参数格式无效' },
        { status: 400 }
      );
    }

    /*
     * 以下兩個早退回 200 空結果，語意都是「沒有東西可給」而不是呼叫端有錯。
     *
     * 兩者都**必須排在所有格式驗證之後**，否則會遮蔽格式錯誤：
     * - `sourceId` 早退放前面 → `?page=0&filters=<壞的>`（不帶 sourceId）
     *   會拿到 200，同一組參數帶了 sourceId 才回 400，回應碼取決於一個
     *   無關的參數。
     * - 分頁上限早退放前面 → `?page=10001&filters=<壞的>` 會拿到 200。
     */
    if (!sourceId) {
      return NextResponse.json({ mangas: [], hasNextPage: false });
    }
    if (!parsedPage.ok) {
      // reason === 'exhausted'：超出我們願意轉發的頁數，等同沒有更多了
      return NextResponse.json({ mangas: [], hasNextPage: false });
    }

    const result = await suwayomiClient.getRecommendedManga(
      sourceId,
      type,
      parsedPage.page,
      filters,
      keyword
    );
    return NextResponse.json(result);
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
