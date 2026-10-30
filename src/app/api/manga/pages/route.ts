import { NextRequest, NextResponse } from 'next/server';

import { suwayomiClient } from '@/lib/suwayomi.client';

import { getMangaViewer, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const viewer = await getMangaViewer(request);
  if (viewer instanceof NextResponse) return viewer;

  try {
    const chapterId = new URL(request.url).searchParams.get('chapterId')?.trim();
    if (!chapterId) {
      return NextResponse.json({ error: '缺少 chapterId' }, { status: 400 });
    }

    const pages = await suwayomiClient.getChapterPages(chapterId, viewer.adult);
    return NextResponse.json({ pages });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
