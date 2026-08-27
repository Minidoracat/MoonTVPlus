import { NextRequest, NextResponse } from 'next/server';

import { parseMangaSourceIds } from '@/lib/manga-search-params';
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
    const page = Number(searchParams.get('page') || '1');

    if (!q) {
      return NextResponse.json({ results: [] });
    }

    const result = await suwayomiClient.searchManga(q, sourceIds, page);
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
