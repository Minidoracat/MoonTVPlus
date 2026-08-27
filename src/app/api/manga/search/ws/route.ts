import { NextRequest, NextResponse } from 'next/server';

import { parseMangaSourceIds } from '@/lib/manga-search-params';
import { suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername } from '../../_utils';

export const runtime = 'nodejs';

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim();
  const sourceIds = parseMangaSourceIds(searchParams);
  const page = Number(searchParams.get('page') || '1');

  if (!q) {
    return NextResponse.json({ error: '缺少搜索关键词' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(payload)));
        } catch {
          closed = true;
        }
      };

      try {
        const sources = await suwayomiClient.getSearchSources(sourceIds);
        let completedSources = 0;
        let totalResults = 0;
        const failedSources: Array<{ sourceId: string; sourceName: string; error: string }> = [];

        send({ type: 'start', totalSources: sources.length });

        // 走 searchMangaSourceWithDeadline 而不是 searchMangaSource：
        // 這裡雖然能逐顆先送 source_result，但 `complete` 仍在 Promise.all
        // 之後，而前端要收到 complete 才停止 loading。少了 per-source 上限，
        // 一顆卡住的來源就能讓整個搜尋 UI 停在載入中直到 20 秒 deadline。
        await Promise.all(
          sources.map(async (source) => {
            const outcome = await suwayomiClient.searchMangaSourceWithDeadline(
              q,
              source,
              page
            );
            completedSources += 1;

            if (outcome.status === 'failed') {
              const failure = {
                sourceId: String(source.id),
                sourceName: outcome.sourceName,
                error: outcome.error,
              };
              failedSources.push(failure);
              send({
                type: 'source_error',
                ...failure,
                completedSources,
                totalSources: sources.length,
                elapsedMs: outcome.elapsedMs,
              });
              return;
            }

            totalResults += outcome.results.length;
            send({
              type: 'source_result',
              sourceId: String(source.id),
              sourceName: outcome.sourceName,
              results: outcome.results,
              completedSources,
              totalSources: sources.length,
              elapsedMs: outcome.elapsedMs,
            });
          })
        );

        send({
          type: 'complete',
          completedSources,
          totalSources: sources.length,
          totalResults,
          failedSources,
          // 全部來源都失敗時，前端不應顯示成「沒有結果」
          allFailed: sources.length > 0 && failedSources.length === sources.length,
        });
      } catch (error) {
        send({
          type: 'error',
          error: error instanceof Error ? error.message : '搜索失败',
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore close races when the client disconnects
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
