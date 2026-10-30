import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { MangaShelfItem } from '@/lib/manga.types';

import { getMangaViewer, hideAdultRecords, rejectAdultRecord } from '../_utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const viewer = await getMangaViewer(request);
  if (viewer instanceof NextResponse) return viewer;

  try {
    const key = new URL(request.url).searchParams.get('key');
    let records: Record<string, MangaShelfItem>;
    if (key) {
      const [sourceId, mangaId] = key.split('+');
      if (!sourceId || !mangaId) {
        return NextResponse.json({ error: 'Invalid key format' }, { status: 400 });
      }
      const item = await db.getMangaShelf(viewer.username, sourceId, mangaId);
      records = item ? { [key]: item } : {};
    } else {
      records = await db.getAllMangaShelf(viewer.username);
    }

    // 成人源 id 從沒取到過（Suwayomi 剛啟動就連不上）時回 503：寧可讀不到也不露出
    const visible = await hideAdultRecords(records, viewer.adult).catch((error) => {
      console.error('[MangaShelf] Failed to load adult source ids:', error);
      return null;
    });
    if (!visible) {
      return NextResponse.json({ error: '漫画来源暂时无法确认，请稍后再试' }, { status: 503 });
    }
    // 單筆被藏起來時與不存在一樣回 null
    return NextResponse.json(key ? visible[key] ?? null : visible, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const viewer = await getMangaViewer(request);
  if (viewer instanceof NextResponse) return viewer;

  try {
    const { key, item }: { key: string; item: MangaShelfItem } = await request.json();
    if (!key || !item?.title) {
      return NextResponse.json({ error: 'Missing key or item' }, { status: 400 });
    }

    const [sourceId, mangaId] = key.split('+');
    if (!sourceId || !mangaId) {
      return NextResponse.json({ error: 'Invalid key format' }, { status: 400 });
    }

    const rejected = await rejectAdultRecord(sourceId, item, viewer.adult);
    if (rejected) return rejected;

    await db.saveMangaShelf(viewer.username, sourceId, mangaId, {
      ...item,
      saveTime: item.saveTime ?? Date.now(),
    });
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const viewer = await getMangaViewer(request);
  if (viewer instanceof NextResponse) return viewer;

  try {
    const key = new URL(request.url).searchParams.get('key');
    if (key) {
      const [sourceId, mangaId] = key.split('+');
      if (!sourceId || !mangaId) {
        return NextResponse.json({ error: 'Invalid key format' }, { status: 400 });
      }
      await db.deleteMangaShelf(viewer.username, sourceId, mangaId);
    } else {
      const all = await db.getAllMangaShelf(viewer.username);
      await Promise.all(Object.keys(all).map(async (itemKey) => {
        const [sourceId, mangaId] = itemKey.split('+');
        if (sourceId && mangaId) {
          await db.deleteMangaShelf(viewer.username, sourceId, mangaId);
        }
      }));
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
