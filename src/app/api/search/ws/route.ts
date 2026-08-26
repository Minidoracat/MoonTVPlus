/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getConfig } from '@/lib/config';
import { getProxyToken } from '@/lib/emby-token';
import { hasFeaturePermission } from '@/lib/permissions';
import {
  executeSavedSourceScript,
  listEnabledSourceScripts,
  normalizeScriptSearchResults,
  normalizeScriptSources,
} from '@/lib/source-script';
import {
  resolveTitleAliases,
  searchFromApiWithQueries,
} from '@/lib/title-alias';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeSpecialSources = searchParams.get('special') === '1';
  const privateOnly = searchParams.get('privateOnly') === '1';

  if (!query) {
    return new Response(
      JSON.stringify({ error: '搜索关键词不能为空' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const config = await getConfig();
  const apiSites = privateOnly
    ? []
    : await getAvailableApiSites(authInfo.username, includeSpecialSources);
  const [canAccessOpenList, canAccessEmby] = await Promise.all([
    hasFeaturePermission(authInfo.username, 'private_library'),
    hasFeaturePermission(authInfo.username, 'emby'),
  ]);

  // 三地片名别名扩展（豆瓣又名）：异步解析，不阻塞 SSE 流的建立与其他源搜索
  const aliasMode =
    searchParams.get('aliasMode') === 'person' ? 'person' : 'title';
  const queriesPromise: Promise<string[]> =
    !privateOnly && searchParams.get('alias') === '1'
      ? resolveTitleAliases(query, aliasMode).then((aliases) => {
          if (aliases.length > 0) {
            console.log('[Search WS] 片名别名扩展:', query, '->', aliases);
          }
          return [query, ...aliases];
        })
      : Promise.resolve([query]);

  // 创建权重映射表
  const weightMap = new Map<string, number>();
  config.SourceConfig.forEach(source => {
    weightMap.set(source.key, source.weight ?? 0);
  });

  // 按权重降序排序 apiSites
  const sortedApiSites = [...apiSites].sort((a, b) => {
    const weightA = weightMap.get(a.key) ?? 0;
    const weightB = weightMap.get(b.key) ?? 0;
    return weightB - weightA;
  });

  // 检查是否配置了 OpenList
  const hasOpenList = !!(
    canAccessOpenList &&
    config.OpenListConfig?.Enabled &&
    config.OpenListConfig?.URL &&
    config.OpenListConfig?.Username &&
    config.OpenListConfig?.Password
  );

  // 检查是否配置了 Emby（支持多源）
  const hasEmby = !!(
    canAccessEmby &&
    config.EmbyConfig?.Sources &&
    config.EmbyConfig.Sources.length > 0 &&
    config.EmbyConfig.Sources.some(s => s.enabled && s.ServerURL)
  );
  const enabledScripts = privateOnly ? [] : await listEnabledSourceScripts();

  // 共享状态
  let streamClosed = false;

  // 创建可读流
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // 辅助函数：安全地向控制器写入数据
      const safeEnqueue = (data: Uint8Array) => {
        try {
          if (streamClosed || (!controller.desiredSize && controller.desiredSize !== 0)) {
            // 流已标记为关闭或控制器已关闭
            return false;
          }
          controller.enqueue(data);
          return true;
        } catch (error) {
          // 控制器已关闭或出现其他错误
          console.warn('Failed to enqueue data:', error);
          streamClosed = true;
          return false;
        }
      };

      // 获取 Emby 源数量
      let embySourcesCount = 0;
      if (hasEmby) {
        try {
          const { embyManager } = await import('@/lib/emby-manager');
          const embySourcesMap = await embyManager.getAllClients();
          embySourcesCount = embySourcesMap.size;
        } catch (error) {
          console.error('[Search WS] 获取 Emby 源数量失败:', error);
        }
      }

      const totalSourceCount = sortedApiSites.length + (hasOpenList ? 1 : 0) + embySourcesCount + enabledScripts.length;

      // 发送开始事件
      const startEvent = `data: ${JSON.stringify({
        type: 'start',
        query,
        totalSources: totalSourceCount,
        timestamp: Date.now()
      })}\n\n`;

      if (!safeEnqueue(encoder.encode(startEvent))) {
        return; // 连接已关闭，提前退出
      }

      // 记录已完成的源数量
      let completedSources = 0;
      // 结果本身已随 SSE 事件送出，服务端只需计数（避免整份 payload 常驻内存）
      let totalResultsCount = 0;

      // 终局判定收敛到单一 helper：每个源完成计数后都要调用，最后完成者负责
      // 发 complete 并关流；否则 emby/openlist 最后完成时 complete 永不发送
      const maybeEmitComplete = () => {
        if (streamClosed || completedSources !== totalSourceCount) return;
        const completeEvent = `data: ${JSON.stringify({
          type: 'complete',
          totalResults: totalResultsCount,
          completedSources,
          timestamp: Date.now()
        })}\n\n`;
        if (safeEnqueue(encoder.encode(completeEvent))) {
          streamClosed = true;
          try {
            controller.close();
          } catch (error) {
            console.warn('Failed to close controller:', error);
          }
        }
      };
      if (totalSourceCount === 0) {
        maybeEmitComplete();
        return;
      }

      // 搜索 Emby（如果配置了）- 异步带超时，支持多源
      if (hasEmby) {
        (async () => {
          let embyCompletedCount = 0;
          try {
            const { embyManager } = await import('@/lib/emby-manager');
            const embySourcesMap = await embyManager.getAllClients();
            const embySources = Array.from(embySourcesMap.values());

            // 获取代理 token（用于图片代理）
            const proxyToken = await getProxyToken(request);

            // 为每个 Emby 源并发搜索，并单独发送结果
            const embySearchPromises = embySources.map(async ({ client, config: embyConfig }) => {
              try {
                const searchResult = await client.getItems({
                  searchTerm: query,
                  IncludeItemTypes: 'Movie,Series',
                  Recursive: true,
                  Fields: 'Overview,ProductionYear',
                  Limit: 50,
                });

                const sourceValue = embySources.length === 1 ? 'emby' : `emby_${embyConfig.key}`;
                const sourceName = embySources.length === 1 ? 'Emby' : embyConfig.name;

                // 添加安全检查，确保 Items 存在且是数组
                const items = Array.isArray(searchResult?.Items) ? searchResult.Items : [];
                const results = items.map((item) => ({
                  id: item.Id,
                  source: sourceValue,
                  source_name: sourceName,
                  weight: weightMap.get(sourceValue) ?? 0,
                  title: item.Name,
                  poster: client.getImageUrl(item.Id, 'Primary', undefined, client.isProxyEnabled() ? proxyToken || undefined : undefined),
                  episodes: [],
                  episodes_titles: [],
                  year: item.ProductionYear?.toString() || '',
                  desc: item.Overview || '',
                  type_name: item.Type === 'Movie' ? '电影' : '电视剧',
                  douban_id: 0,
                }));

                // 单独发送每个源的结果
                embyCompletedCount++;
                completedSources++;
                if (!streamClosed) {
                  const sourceEvent = `data: ${JSON.stringify({
                    type: 'source_result',
                    source: sourceValue,
                    sourceName: sourceName,
                    results: results,
                    timestamp: Date.now()
                  })}\n\n`;
                  if (safeEnqueue(encoder.encode(sourceEvent))) {
                    if (results.length > 0) {
                      totalResultsCount += results.length;
                    }
                  } else {
                    streamClosed = true;
                  }
                }
                maybeEmitComplete();

                return results;
              } catch (error) {
                console.error(`[Search WS] 搜索 ${embyConfig.name} 失败:`, error);
                embyCompletedCount++;
                completedSources++;
                // 发送空结果
                if (!streamClosed) {
                  const sourceValue = embySources.length === 1 ? 'emby' : `emby_${embyConfig.key}`;
                  const sourceName = embySources.length === 1 ? 'Emby' : embyConfig.name;
                  const sourceEvent = `data: ${JSON.stringify({
                    type: 'source_result',
                    source: sourceValue,
                    sourceName: sourceName,
                    results: [],
                    timestamp: Date.now()
                  })}\n\n`;
                  safeEnqueue(encoder.encode(sourceEvent));
                }
                maybeEmitComplete();
                return [];
              }
            });

            await Promise.all(embySearchPromises);
          } catch (error) {
            console.error('[Search WS] 搜索 Emby 整体失败:', error);
            // 如果整个 emby 搜索失败，需要补齐未完成的源
            const remainingSources = embySourcesCount - embyCompletedCount;
            for (let i = 0; i < remainingSources; i++) {
              completedSources++;
              if (!streamClosed) {
                const sourceEvent = `data: ${JSON.stringify({
                  type: 'source_result',
                  source: 'emby',
                  sourceName: 'Emby',
                  results: [],
                  timestamp: Date.now()
                })}\n\n`;
                safeEnqueue(encoder.encode(sourceEvent));
              }
            }
            maybeEmitComplete();
          }
        })();
      }

      // 搜索 OpenList（如果配置了）- 异步带超时
      if (hasOpenList) {
        Promise.race([
          (async () => {
            try {
              const { getCachedMetaInfo, setCachedMetaInfo } = await import('@/lib/openlist-cache');
              const { getTMDBImageUrl } = await import('@/lib/tmdb.search');
              const { db } = await import('@/lib/db');

              let metaInfo = getCachedMetaInfo();

              if (!metaInfo) {
                const metainfoJson = await db.getGlobalValue('video.metainfo');
                if (metainfoJson) {
                  metaInfo = JSON.parse(metainfoJson);
                  if (metaInfo) {
                    setCachedMetaInfo(metaInfo);
                  }
                }
              }

              if (metaInfo && metaInfo.folders) {
                return Object.entries(metaInfo.folders)
                  .filter(([key, info]: [string, any]) => {
                    const matchFolder = info.folderName.toLowerCase().includes(query.toLowerCase());
                    const matchTitle = info.title.toLowerCase().includes(query.toLowerCase());
                    return matchFolder || matchTitle;
                  })
                  .map(([key, info]: [string, any]) => ({
                    id: key,
                    source: 'openlist',
                    source_name: '私人影库',
                    weight: weightMap.get('openlist') ?? 0,
                    title: info.title,
                    poster: getTMDBImageUrl(info.poster_path),
                    episodes: [],
                    episodes_titles: [],
                    year: info.release_date.split('-')[0] || '',
                    desc: info.overview,
                    type_name: info.media_type === 'movie' ? '电影' : '电视剧',
                    douban_id: 0,
                  }));
              }
              return [];
            } catch (error) {
              console.error('[Search WS] 搜索 OpenList 失败:', error);
              return [];
            }
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('OpenList timeout')), 20000)
          ),
        ])
          .then((openlistResults: any) => {
            completedSources++;
            if (!streamClosed) {
              // 添加安全检查，确保结果是数组
              const safeResults = Array.isArray(openlistResults) ? openlistResults : [];
              const sourceEvent = `data: ${JSON.stringify({
                type: 'source_result',
                source: 'openlist',
                sourceName: '私人影库',
                results: safeResults,
                timestamp: Date.now()
              })}\n\n`;
              if (!safeEnqueue(encoder.encode(sourceEvent))) {
                streamClosed = true;
                return;
              }
              if (safeResults.length > 0) {
                totalResultsCount += safeResults.length;
              }
            }
            maybeEmitComplete();
          })
          .catch((error) => {
            console.error('[Search WS] 搜索 OpenList 超时:', error);
            completedSources++;
            if (!streamClosed) {
              const sourceEvent = `data: ${JSON.stringify({
                type: 'source_result',
                source: 'openlist',
                sourceName: '私人影库',
                results: [],
                timestamp: Date.now()
              })}\n\n`;
              safeEnqueue(encoder.encode(sourceEvent));
            }
            maybeEmitComplete();
          });
      }

      // 等待别名解析（start 事件与 Emby/OpenList 搜索已先行，不被阻塞）
      const queries = await queriesPromise;
      if (queries.length > 1 && !streamClosed) {
        // 告知前端别名集合，供精确搜索过滤时一并匹配
        const aliasEvent = `data: ${JSON.stringify({
          type: 'aliases',
          aliases: queries.slice(1),
          timestamp: Date.now()
        })}\n\n`;
        safeEnqueue(encoder.encode(aliasEvent));
      }

      // 人物模式的作品名可能很多，按批切分渐进搜索：首批（原词 + 5 别名）
      // 与旧行为等宽保证首屏速度，其余批次逐批补发 partial 事件
      const QUERY_BATCH_SIZE = 6;
      // 单站总预算：每批各有 20s 超时，病态慢站（每批都慢但不超时）最坏可拖
      // 批数×20s；用总预算兜底 SSE 流寿命，耗尽即放弃剩余批次（已发结果保留）
      const SITE_TOTAL_BUDGET = 60000;
      const queryBatches: string[][] = [];
      for (let i = 0; i < queries.length; i += QUERY_BATCH_SIZE) {
        queryBatches.push(queries.slice(i, i + QUERY_BATCH_SIZE));
      }

      // 为每个源创建搜索 Promise
      const searchPromises = sortedApiSites.map(async (site) => {
        // 跨批次去重：每批只发送新增结果
        const seenKeys = new Set<string>();
        const siteDeadline = Date.now() + SITE_TOTAL_BUDGET;
        for (
          let batchIndex = 0;
          batchIndex < queryBatches.length && !streamClosed;
          batchIndex++
        ) {
          const isLastBatch = batchIndex === queryBatches.length - 1;
          // 首批不受预算限制；后续批次在预算耗尽时补一个终批空事件收尾
          if (batchIndex > 0 && Date.now() > siteDeadline) {
            const finalEvent = `data: ${JSON.stringify({
              type: 'source_result',
              source: site.key,
              sourceName: site.name,
              results: [],
              partial: false,
              timestamp: Date.now()
            })}\n\n`;
            if (!safeEnqueue(encoder.encode(finalEvent))) {
              streamClosed = true;
            }
            break;
          }
          try {
            // 添加超时控制（按批计时，批内关键词仍串行防打爆站点）
            const searchPromise = Promise.race([
              searchFromApiWithQueries(site, queryBatches[batchIndex], seenKeys),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`${site.name} timeout`)), 20000)
              ),
            ]);

            const results = await searchPromise as any[];

            // 添加安全检查，确保结果是数组
            const safeResults = Array.isArray(results) ? results : [];

            // 过滤黄色内容
            let filteredResults = safeResults;
            if (!config.SiteConfig.DisableYellowFilter) {
              filteredResults = safeResults.filter((result) => {
                const typeName = result.type_name || '';
                return !yellowWords.some((word: string) => typeName.includes(word));
              });
            }

            filteredResults = filteredResults.map((result) => ({
              ...result,
              weight: result.weight ?? (weightMap.get(result.source) ?? 0),
            }));

            // 发送该源的搜索结果；partial 表示该源还有后续批次，前端不计入完成数
            if (!streamClosed) {
              const sourceEvent = `data: ${JSON.stringify({
                type: 'source_result',
                source: site.key,
                sourceName: site.name,
                results: filteredResults,
                partial: !isLastBatch,
                timestamp: Date.now()
              })}\n\n`;

              if (!safeEnqueue(encoder.encode(sourceEvent))) {
                streamClosed = true;
                break; // 连接已关闭，停止处理
              }
            }

            if (filteredResults.length > 0) {
              totalResultsCount += filteredResults.length;
            }

          } catch (error) {
            console.warn(`搜索失败 ${site.name}:`, error);

            // 发送源错误事件；该站已超时/失败，跳过剩余批次避免拖满全场
            if (!streamClosed) {
              const errorEvent = `data: ${JSON.stringify({
                type: 'source_error',
                source: site.key,
                sourceName: site.name,
                error: error instanceof Error ? error.message : '搜索失败',
                timestamp: Date.now()
              })}\n\n`;

              if (!safeEnqueue(encoder.encode(errorEvent))) {
                streamClosed = true;
              }
            }
            break;
          }
        }

        // 每站恰好计数一次，与退出原因（跑完全部批次/失败/流关闭）解耦，
        // 避免 partial 批次之间流被他源关闭时漏计导致 complete 判定永不成立
        completedSources++;

        // 检查是否所有源都已完成
        maybeEmitComplete();
      });

      const scriptPromises = enabledScripts.map(async (script) => {
        try {
          const sourcesExecution = await Promise.race([
            executeSavedSourceScript({
              key: script.key,
              hook: 'getSources',
              payload: {},
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`${script.name} timeout`)), 20000)
            ),
          ]);

          const sources = normalizeScriptSources((sourcesExecution as any).result);
          const sourceResults = await Promise.all(
            sources.map(async (source) => {
              const execution = await Promise.race([
                executeSavedSourceScript({
                  key: script.key,
                  hook: 'search',
                  payload: {
                    keyword: query,
                    page: 1,
                    sourceId: source.id,
                  },
                }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`${script.name}/${source.name} timeout`)), 20000)
                ),
              ]);

              return normalizeScriptSearchResults({
                scriptKey: script.key,
                scriptName: script.name,
                sourceId: source.id,
                sourceName: source.name,
                result: (execution as any).result,
              });
            })
          );

          let filteredResults = sourceResults.flat();
          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = filteredResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word: string) => typeName.includes(word));
            });
          }

          completedSources++;

          if (!streamClosed) {
            const sourceEvent = `data: ${JSON.stringify({
              type: 'source_result',
              source: `script:${script.key}`,
              sourceName: script.name,
              results: filteredResults,
              timestamp: Date.now()
            })}\n\n`;

            if (!safeEnqueue(encoder.encode(sourceEvent))) {
              streamClosed = true;
              return;
            }
          }

          if (filteredResults.length > 0) {
            totalResultsCount += filteredResults.length;
          }
        } catch (error) {
          console.warn(`搜索脚本失败 ${script.name}:`, error);

          completedSources++;

          if (!streamClosed) {
            const errorEvent = `data: ${JSON.stringify({
              type: 'source_error',
              source: `script:${script.key}`,
              sourceName: script.name,
              error: error instanceof Error ? error.message : '搜索失败',
              timestamp: Date.now()
            })}\n\n`;

            if (!safeEnqueue(encoder.encode(errorEvent))) {
              streamClosed = true;
              return;
            }
          }
        }

        maybeEmitComplete();
      });

      // 等待所有搜索完成
      await Promise.allSettled([...searchPromises, ...scriptPromises]);
    },

    cancel() {
      // 客户端断开连接时，标记流已关闭
      streamClosed = true;
      console.log('Client disconnected, cancelling search stream');
    },
  });

  // 返回流式响应
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
