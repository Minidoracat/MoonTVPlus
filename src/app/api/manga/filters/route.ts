import { NextRequest, NextResponse } from 'next/server';

import { suwayomiClient } from '@/lib/suwayomi.client';

import { getMangaViewer, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const viewer = await getMangaViewer(request);
  if (viewer instanceof NextResponse) return viewer;

  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get('sourceId')?.trim();

  if (!sourceId) {
    return NextResponse.json({ filters: [] });
  }

  try {
    const filters = await suwayomiClient.getSourceFilters(sourceId, viewer.adult);
    return NextResponse.json({ filters });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
