/* eslint-disable no-console */

import * as cheerio from 'cheerio/slim';

import { getConfig } from '@/lib/config';
import { getStorage } from '@/lib/db';
import {
  fetchDoubanWithVerification,
  isDoubanBlocked,
} from '@/lib/douban-anti-crawler';
import { DoubanComment, DoubanCommentCacheMeta, IStorage } from '@/lib/types';

export const DOUBAN_PAGE_SIZE = 20;
const HEAD_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 距上次成功抓取超过此值，打开首页时回豆瓣合并新评论
const RETRY_AFTER_MS = 12 * 60 * 60 * 1000; // 403/404/空页后多久再试
const TRANSIENT_RETRY_MS = 60 * 60 * 1000; // 超时/网络/5xx 后多久再试
const MAX_PAGES_PER_CALL = 2; // 单次请求最多向豆瓣翻几页，限制响应延迟

export interface DoubanCommentPage {
  comments: DoubanComment[];
  total: number; // 0 = 页面上没找到
  hasNext: boolean;
  isCommentsPage: boolean; // 页面确实是短评列表（有 #comments 容器）；false = 登录墙/改版等非预期页面
}

export function parseDoubanCommentsHtml(html: string): DoubanCommentPage {
  const $ = cheerio.load(html);
  const comments: DoubanComment[] = [];

  $('.comment-item').each((_, element) => {
    const $comment = $(element);
    const commentId = $comment.attr('data-cid') || '';

    const $avatar = $comment.find('.avatar');
    const userUrl = $avatar.find('a').attr('href') || '';
    const userAvatar = $avatar.find('img').attr('src') || '';
    const userName = $avatar.find('a').attr('title') || '';

    const ratingMatch = ($comment.find('.rating').attr('class') || '').match(
      /allstar(\d)0/
    );
    const rating = ratingMatch ? parseInt(ratingMatch[1]) : null;

    const content = $comment.find('.short').text().trim();
    const time =
      $comment.find('.comment-info').find('.comment-time').attr('title') || '';
    const votes =
      parseInt($comment.find('.votes.vote-count').text().trim()) || 0;

    if (commentId && content) {
      comments.push({
        id: commentId,
        userName,
        userAvatar,
        userUrl,
        rating,
        content,
        time,
        votes,
      });
    }
  });

  // 总数：标题 "全部 XXX 条" → 导航 "看过(XXX)" → 全文兜底
  let total = 0;
  const titleMatch = $('.mod-hd h2, h2, .section-title')
    .text()
    .match(/全部\s*(\d+)\s*条/);
  if (titleMatch) {
    total = parseInt(titleMatch[1]);
  }
  if (total === 0) {
    const navMatch = $('.tabs, .nav-tabs, a').text().match(/看过\s*\((\d+)\)/);
    if (navMatch) {
      total = parseInt(navMatch[1]);
    }
  }
  if (total === 0) {
    const bodyMatch = $('body')
      .text()
      .match(/全部\s*(\d+)\s*条|看过\s*\((\d+)\)/);
    if (bodyMatch) {
      total = parseInt(bodyMatch[1] || bodyMatch[2]);
    }
  }

  return {
    comments,
    total,
    hasNext: $('a.next').length > 0,
    isCommentsPage: $('#comments').length > 0,
  };
}

export interface DoubanFetchFailure {
  status: number; // 豆瓣 HTTP 状态、闸门合成的 429/503，或 0 = 抛错（超时/网络）
  gated: boolean; // true = 闸门挡下（冷却/饱和），没有真的出网
  retryAfter: string | null; // 透传给 API 调用方
}

/**
 * 抓一页豆瓣短评；失败返回 DoubanFetchFailure
 */
export async function fetchDoubanCommentPage(
  doubanId: string,
  start: number,
  limit = DOUBAN_PAGE_SIZE
): Promise<DoubanCommentPage | DoubanFetchFailure> {
  const url = `https://movie.douban.com/subject/${doubanId}/comments?start=${start}&limit=${limit}&status=P&sort=new_score`;
  try {
    const response = await fetchDoubanWithVerification(url);
    if (!response.ok) {
      console.warn(
        `豆瓣短评请求被拒 (id=${doubanId} start=${start}): ${response.status}`
      );
      return {
        status: response.status,
        gated: response.headers.has('X-Douban-Gate'),
        retryAfter: response.headers.get('Retry-After'),
      };
    }
    return parseDoubanCommentsHtml(await response.text());
  } catch (error) {
    console.error(`豆瓣短评请求失败 (id=${doubanId} start=${start}):`, error);
    return { status: 0, gated: false, retryAfter: null };
  }
}

/**
 * 失败后该片多久不再抓：
 * - 闸门挡下 / 全局冷却中：不罚该片，由闸门自己恢复
 * - 403 / 404：登录墙或不存在，12 小时
 * - 其他（超时、网络、5xx，含豆瓣本体的 503）：1 小时
 */
function retryDelayFor(failure: DoubanFetchFailure): number {
  if (failure.gated || isDoubanBlocked()) return 0;
  return failure.status === 403 || failure.status === 404
    ? RETRY_AFTER_MS
    : TRANSIENT_RETRY_MS;
}

/**
 * 200 但不是短评页（登录墙 / 改版）：同 403 罚 12 小时；全局冷却中同样不罚该片
 */
function loginWallDelay(): number {
  console.warn('豆瓣短评返回 200 但不是短评页（登录墙或改版），按失败处理');
  return isDoubanBlocked() ? 0 : RETRY_AFTER_MS;
}

export interface DoubanCommentStore {
  getDoubanCommentPage: NonNullable<IStorage['getDoubanCommentPage']>;
  appendDoubanComments: NonNullable<IStorage['appendDoubanComments']>;
}

/**
 * 当前存储后端支持落地时返回读写方法；SQL / localstorage 后端返回 null（API 走直连）
 */
export function getDoubanCommentStore(): DoubanCommentStore | null {
  const storage = getStorage() as IStorage | null;
  if (!storage?.getDoubanCommentPage || !storage.appendDoubanComments) {
    return null;
  }
  return {
    getDoubanCommentPage: storage.getDoubanCommentPage.bind(storage),
    appendDoubanComments: storage.appendDoubanComments.bind(storage),
  };
}

// 同一部片的抓取串行执行：后到的请求等前一个结束后按自己的 needCount 再检查一次（本地够了就不出网）
const inflight = new Map<string, Promise<unknown>>();

/**
 * 尽量让本地有 needCount 条：不足且豆瓣还有更多时续抓，单次最多 MAX_PAGES_PER_CALL 页；
 * refreshHead 且距上次成功抓取超过 HEAD_REFRESH_MS 时，先回豆瓣 start=0 合并新评论（按首次见到的顺序追加）。
 * 返回最新 meta（可能是 count=0 的失败记录，路由据 count/fetchedAt 判定）；存储不支持时返回 null。
 */
export function ensureDoubanComments(
  doubanId: string,
  needCount: number,
  refreshHead: boolean
): Promise<DoubanCommentCacheMeta | null> {
  const previous = inflight.get(doubanId) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() => fillLocal(doubanId, needCount, refreshHead));
  inflight.set(doubanId, task);
  task
    .finally(() => {
      if (inflight.get(doubanId) === task) inflight.delete(doubanId);
    })
    .catch(() => undefined);
  return task;
}

async function fillLocal(
  doubanId: string,
  needCount: number,
  refreshHead: boolean
): Promise<DoubanCommentCacheMeta | null> {
  const store = getDoubanCommentStore();
  if (!store) return null;

  let { meta } = await store.getDoubanCommentPage(doubanId, 0, 0);
  const now = Date.now();
  let pages = 0;
  const canFetch = () =>
    pages < MAX_PAGES_PER_CALL &&
    !isDoubanBlocked() &&
    (meta?.retryAfter ?? 0) <= now;

  // 已成功抓过、且距上次成功超过阈值：回首页合并新评论；抓到"后页"说明之前的 exhausted 已过时
  // 从未成功的失败记录（fetchedAt=0）走下面的常规补抓，让首次成功正常推进 nextStart
  if (
    meta &&
    meta.fetchedAt > 0 &&
    refreshHead &&
    now - meta.fetchedAt > HEAD_REFRESH_MS &&
    canFetch()
  ) {
    pages++;
    const page = await fetchDoubanCommentPage(doubanId, 0);
    // 短评页但 0 条：合法空页；非短评页（登录墙/改版）的 0 条按失败处理
    if ('status' in page || (page.comments.length === 0 && !page.isCommentsPage)) {
      // 与常规补抓一致：闸门挡下 / 冷却中不写 meta，直接结束本次
      const delay = 'status' in page ? retryDelayFor(page) : loginWallDelay();
      if (delay === 0) return meta;
      meta = await store.appendDoubanComments(doubanId, [], {
        ...meta,
        retryAfter: now + delay,
      });
    } else {
      // 首页有"后页"→ 还有更多（清掉旧 exhausted）；没有 → 豆瓣整份列表就这一页，到底
      // 尾页游标按实际条数推进（见下），续抓会从正确 offset 接上
      meta = await store.appendDoubanComments(doubanId, page.comments, {
        ...meta,
        total: page.total || meta.total,
        exhausted: !page.hasNext,
        fetchedAt: now,
      });
    }
  }

  while ((meta?.count ?? 0) < needCount && !meta?.exhausted && canFetch()) {
    pages++;
    const base: Omit<DoubanCommentCacheMeta, 'count'> = meta ?? {
      nextStart: 0,
      total: 0,
      exhausted: false,
      retryAfter: 0,
      fetchedAt: 0,
    };
    const page = await fetchDoubanCommentPage(doubanId, base.nextStart);
    // 非短评页（登录墙/改版）的 0 条不能当作"到底了"，按失败处理；短评页的 0 条是合法空页 → 到底
    if ('status' in page || (page.comments.length === 0 && !page.isCommentsPage)) {
      const delay = 'status' in page ? retryDelayFor(page) : loginWallDelay();
      if (delay > 0) {
        meta = await store.appendDoubanComments(doubanId, [], {
          ...base,
          retryAfter: now + delay,
        });
      }
      break;
    }
    meta = await store.appendDoubanComments(doubanId, page.comments, {
      // 满页按页宽推进；不满的尾页只推进实际条数，之后评论增长时能从正确 offset 接上
      nextStart:
        base.nextStart + (page.hasNext ? DOUBAN_PAGE_SIZE : page.comments.length),
      total: page.total || base.total,
      exhausted: !page.hasNext,
      retryAfter: 0,
      fetchedAt: now,
    });
  }

  return meta;
}

/**
 * 预热：给一批 doubanId 抓首页落地（跳过已有数据或仍在 retryAfter 内的），每轮最多 quota 部，遇拒即停。
 */
export async function prewarmDoubanComments(
  doubanIds: Iterable<number | string | undefined>,
  quota = 3
): Promise<void> {
  const store = getDoubanCommentStore();
  if (!store) return;
  const config = await getConfig();
  if (!config.SiteConfig.EnableComments) return;

  let used = 0;
  for (const raw of Array.from(new Set(doubanIds))) {
    if (used >= quota || isDoubanBlocked()) break;
    const doubanId = String(raw ?? '');
    if (!/^\d+$/.test(doubanId) || Number(doubanId) <= 0) continue; // 与 route 同一道验证：拼 URL 与 key 前必须是纯数字
    const { meta } = await store.getDoubanCommentPage(doubanId, 0, 0);
    if (meta && (meta.count > 0 || meta.retryAfter > Date.now())) continue;

    used++;
    const result = await ensureDoubanComments(doubanId, DOUBAN_PAGE_SIZE, false);
    if (!result || result.retryAfter > Date.now()) break; // 被拒就结束整轮
  }
  if (used > 0) {
    console.log(`豆瓣短评预热完成: ${used} 部`);
  }
}
