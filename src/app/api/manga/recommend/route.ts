import { NextRequest, NextResponse } from 'next/server';

import { parseMangaFilterSelections } from '@/lib/manga-filter-params';
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
    const page = Number(searchParams.get('page') || '1');
    const typeParam = searchParams.get('type')?.trim().toUpperCase();
    const type: MangaRecommendType = typeParam === 'LATEST' ? 'LATEST' : 'POPULAR';

    if (!sourceId) {
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
      page,
      filters
    );
    return NextResponse.json(result);
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
