import { NextRequest, NextResponse } from 'next/server';

import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get('sourceId')?.trim();

  if (!sourceId) {
    return NextResponse.json({ filters: [] });
  }

  try {
    const filters = await suwayomiClient.getSourceFilters(sourceId);
    return NextResponse.json({ filters });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
