import { NextRequest, NextResponse } from 'next/server';

import {
  MAX_KEYWORD_LENGTH,
  parseMangaPage,
  parseMangaSourceIds,
} from '@/lib/manga-search-params';
import {
  isAllMangaSourcesFailed,
  type MangaSearchFailure,
} from '@/lib/manga.types';
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
  const parsedPage = parseMangaPage(searchParams.get('page'));

  /*
   * 與 /api/manga/search 同一組防線：這條也是對所有啟用來源 fan-out，
   * 畸形 page 或超長關鍵字會放大成數十次對外請求。
   * 格式驗證排在語意性早退之前。
   */
  if (q && q.length > MAX_KEYWORD_LENGTH) {
    return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
  }
  if (!parsedPage.ok && parsedPage.reason === 'invalid') {
    return NextResponse.json({ error: 'page 参数无效' }, { status: 400 });
  }

  if (!q) {
    return NextResponse.json({ error: '缺少搜索关键词' }, { status: 400 });
  }
  // 超出願意轉發的頁數：這條是 SSE，回一個立即結束的空結果比開串流合理
  if (!parsedPage.ok) {
    return NextResponse.json({ results: [] });
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
        /*
         * 用 MangaSearchFailure 而不是就地寫 inline 型別：這個陣列會在
         * complete 事件送給前端，形狀必須與非流式路徑的 failedSources 一致。
         * inline 型別漏了 timedOut 而 tsc 不會抱怨，正是兩條路徑漂移的成因。
         */
        const failedSources: MangaSearchFailure[] = [];

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
              parsedPage.page
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
                timedOut: outcome.timedOut,
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
