import { NextRequest, NextResponse } from 'next/server';

import { parseMangaSourceIds } from '@/lib/manga-search-params';
import { isAllMangaSourcesFailed } from '@/lib/manga.types';
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

            // 進度與事件共用同一段 payload，且遞增在分支之前只出現一次：
            // 前端要收滿 completedSources 才會停止 loading，任何一支忘了
            // 遞增都會讓搜尋永遠轉圈。
            completedSources += 1;
            const progress = {
              sourceId: String(source.id),
              sourceName: outcome.sourceName,
              completedSources,
              totalSources: sources.length,
              elapsedMs: outcome.elapsedMs,
            };

            if (outcome.status === 'failed') {
              failedSources.push({
                sourceId: progress.sourceId,
                sourceName: progress.sourceName,
                error: outcome.error,
              });
              send({
                type: 'source_error',
                ...progress,
                error: outcome.error,
                // 前端靠這個把「逾時」和「失效」分開存進來源健康度
                timedOut: outcome.timedOut,
              });
              return;
            }

            totalResults += outcome.results.length;
            send({
              type: 'source_result',
              ...progress,
              results: outcome.results,
            });
          })
        );

        send({
          type: 'complete',
          completedSources,
          totalSources: sources.length,
          totalResults,
          failedSources,
          allFailed: isAllMangaSourcesFailed(
            sources.length,
            failedSources.length
          ),
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
