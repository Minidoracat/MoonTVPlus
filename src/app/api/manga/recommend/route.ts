import { NextRequest, NextResponse } from 'next/server';

import { MangaFilterSelection, MangaRecommendType } from '@/lib/manga.types';
import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

function readNumber(source: object, key: string): number | null {
  if (!(key in source)) return null;
  const value = Reflect.get(source, key);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** 回傳 null 代表格式無效（呼叫端應回 400），空陣列代表沒有帶 filters */
function parseFilters(raw: string | null): MangaFilterSelection[] | null {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: MangaFilterSelection[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return null;

    const position = readNumber(entry, 'position');
    const index = readNumber(entry, 'index');
    if (position === null || index === null) return null;

    const kind = 'kind' in entry ? Reflect.get(entry, 'kind') : undefined;
    if (kind !== 'select' && kind !== 'sort') return null;

    const ascending =
      'ascending' in entry ? Reflect.get(entry, 'ascending') : undefined;
    if (ascending !== undefined && typeof ascending !== 'boolean') return null;

    out.push({
      position,
      index,
      kind,
      ...(typeof ascending === 'boolean' ? { ascending } : {}),
    });
  }
  return out;
}

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

    const filters = parseFilters(searchParams.get('filters'));
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
