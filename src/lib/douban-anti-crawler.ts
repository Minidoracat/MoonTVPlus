import * as cheerio from 'cheerio/slim';
import { createHash } from 'crypto';

/**
 * Cookie 缓存
 */
interface CookieCache {
  cookie: string;
  expiresAt: number;
}

let cookieCache: CookieCache | null = null;

/**
 * 豆瓣请求闸门：豆瓣按 IP 限流，所有经 fetchDoubanWithVerification 的调用方（短评、推荐）共用
 * - 请求（含反爬验证 PoW）串行执行，下一个从上一个结束起算 MIN_INTERVAL_MS 间隔（加随机抖动）
 * - 任一豆瓣响应 429 → 冷却 BLOCK_COOLDOWN_MS，期间不出网直接返回合成 429（带 Retry-After）
 * - 队列超过 MAX_PENDING → 直接返回合成 503，避免一个用户狂切片把所有人的短评/推荐排到几分钟后
 * - 每次出网 FETCH_TIMEOUT_MS 超时，避免单次 hang 卡住整条队列
 * ponytail: 单进程内存闸门；多实例部署时需搬到共享存储
 */
const MIN_INTERVAL_MS = 1500;
const BLOCK_COOLDOWN_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_PENDING = 8;
export const GATE_SATURATED_RETRY_SECONDS = 30; // 队列饱和时建议客户端多久后重试
let lastRequestEndedAt = 0;
let blockedUntil = 0;
let pending = 0;
let gateQueue: Promise<unknown> = Promise.resolve();

export function isDoubanBlocked(): boolean {
  return Date.now() < blockedUntil;
}

// 冷却剩余秒数（0 = 未冷却），给 API 层填 Retry-After
export function doubanCooldownSeconds(): number {
  return Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
}

// 不出网时给调用方一个可判定的合成响应；X-Douban-Gate 让调用方区分"闸门挡下"与"豆瓣本体的 429/503"
function localResponse(status: 429 | 503): Response {
  const retryAfter =
    status === 429 ? doubanCooldownSeconds() || 1 : GATE_SATURATED_RETRY_SECONDS;
  return new Response(null, {
    status,
    headers: {
      'Retry-After': String(retryAfter),
      'X-Douban-Gate': status === 429 ? 'cooldown' : 'saturated',
    },
  });
}

// 豆瓣任何一步回 429 都算限流；不能当成 cookie 失效再重试
function markRateLimited(response: Response): Response {
  if (response.status === 429 && !isDoubanBlocked()) {
    blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
    console.warn(
      `Douban rate limited (429), cooling down ${BLOCK_COOLDOWN_MS / 60000} min`
    );
  }
  return response;
}

function throughGate(task: () => Promise<Response>): Promise<Response> {
  if (pending >= MAX_PENDING) {
    console.warn(`Douban gate saturated (${pending} pending), rejecting`);
    return Promise.resolve(localResponse(503));
  }
  pending++;
  const turn = gateQueue.then(async () => {
    // 排队期间 / 等间隔期间都可能刚收到 429：两处短路，不出网
    if (isDoubanBlocked()) return localResponse(429);
    const delay =
      lastRequestEndedAt + MIN_INTERVAL_MS + Math.random() * 500 - Date.now();
    if (delay > 0) {
      // TS 4.9 无 Promise.withResolvers 类型，保留 executor 形式
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (isDoubanBlocked()) return localResponse(429);
    }
    try {
      return await task();
    } finally {
      lastRequestEndedAt = Date.now();
    }
  });
  gateQueue = turn.catch(() => undefined);
  return turn.finally(() => {
    pending--;
  });
}

/**
 * 从 Set-Cookie header 中提取 cookie 值
 */
function extractCookieValue(setCookieHeader: string): string {
  // 提取 dbsawcv1 的值
  const match = setCookieHeader.match(/dbsawcv1=([^;]+)/);
  if (match) {
    return `dbsawcv1=${match[1]}`;
  }
  return setCookieHeader.split(';')[0];
}

/**
 * 检查缓存的 cookie 是否有效
 */
function isCookieCacheValid(): boolean {
  if (!cookieCache) {
    return false;
  }
  // 提前 20 秒过期，确保不会在使用时过期
  return Date.now() < cookieCache.expiresAt - 20000;
}

/**
 * 计算 SHA-512 哈希值
 */
function sha512(data: string): string {
  return createHash('sha512').update(data).digest('hex');
}

/**
 * 工作量证明算法 - 寻找满足难度要求的 nonce
 * @param data 要哈希的数据
 * @param difficulty 难度（前导零的数量）
 * @returns 满足条件的 nonce
 */
function proofOfWork(data: string, difficulty = 4): number {
  let nonce = 0;
  const targetSubStr = '0'.repeat(difficulty);

  for (;;) {
    nonce += 1;
    const hash = sha512(data + nonce);
    if (hash.startsWith(targetSubStr)) {
      return nonce;
    }
  }
}

/**
 * 解析豆瓣验证页面，提取表单数据
 */
function parseVerificationPage(html: string): {
  tok: string;
  cha: string;
  red: string;
} | null {
  const $ = cheerio.load(html);

  const tok = $('#tok').val() as string;
  const cha = $('#cha').val() as string;
  const red = $('#red').val() as string;

  if (!tok || !cha || !red) {
    console.error('Failed to extract verification form data');
    return null;
  }

  return { tok, cha, red };
}

/**
 * 获取豆瓣访问 cookie（处理反爬验证）
 * @param url 要访问的豆瓣 URL
 * @param forceRefresh 是否强制刷新 cookie
 * @returns cookie 字符串
 */
export async function getDoubanCookie(url: string, forceRefresh = false): Promise<string> {
  // 检查缓存
  if (!forceRefresh && isCookieCacheValid()) {
    console.log('Using cached douban cookie');
    return cookieCache!.cookie;
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://movie.douban.com/',
  };

  try {
    // 第一步：访问目标 URL，可能会被重定向到验证页面
    const firstResponse = markRateLimited(
      await fetch(url, {
        headers,
        redirect: 'manual', // 手动处理重定向
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );

    // 如果没有重定向，直接返回 cookie
    if (firstResponse.status === 200) {
      const cookies = firstResponse.headers.get('set-cookie');
      return cookies || '';
    }

    // 如果是 302 重定向到验证页面
    if (firstResponse.status === 302) {
      const location = firstResponse.headers.get('location');
      if (!location || !location.includes('sec.douban.com')) {
        throw new Error('Unexpected redirect location');
      }

      console.log('Detected anti-crawler verification, processing...');

      // 第二步：访问验证页面
      const verifyResponse = markRateLimited(
        await fetch(location, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      );

      if (!verifyResponse.ok) {
        throw new Error(`Failed to fetch verification page: ${verifyResponse.status}`);
      }

      const verifyHtml = await verifyResponse.text();

      // 第三步：解析验证页面，提取表单数据
      const formData = parseVerificationPage(verifyHtml);
      if (!formData) {
        throw new Error('Failed to parse verification page');
      }

      console.log('Calculating proof of work...');

      // 第四步：计算工作量证明
      const sol = proofOfWork(formData.cha, 4);

      console.log('Proof of work calculated:', sol);

      // 第五步：提交验证表单
      const formBody = new URLSearchParams({
        tok: formData.tok,
        cha: formData.cha,
        sol: sol.toString(),
        red: formData.red,
      });

      const submitResponse = markRateLimited(
        await fetch('https://sec.douban.com/c', {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formBody.toString(),
          redirect: 'manual', // 手动处理重定向
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      );

      // 提交被限流：即使带了 Set-Cookie 也不能当成功，让上层按 429 处理
      if (submitResponse.status === 429) {
        throw new Error('Rate limited while submitting verification');
      }

      // 第六步：从响应中提取 cookie
      const setCookieHeader = submitResponse.headers.get('set-cookie');
      if (!setCookieHeader) {
        throw new Error('No cookie received after verification');
      }

      console.log('Successfully obtained douban cookie');

      // 提取 cookie 值并缓存（有效期 300 秒 = 5 分钟）
      const cookieValue = extractCookieValue(setCookieHeader);
      cookieCache = {
        cookie: cookieValue,
        expiresAt: Date.now() + 300000, // 5 分钟后过期
      };

      return cookieValue;
    }

    throw new Error(`Unexpected response status: ${firstResponse.status}`);
  } catch (error) {
    console.error('Failed to get douban cookie:', error);
    throw error;
  }
}

/**
 * 带反爬验证的豆瓣请求
 * 经全局闸门串行；冷却期或队列饱和时不出网，返回合成 429 / 503（调用方按 !ok 处理即可）
 * @param url 要访问的豆瓣 URL
 * @param options fetch 选项
 * @returns Response 对象
 */
export function fetchDoubanWithVerification(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (isDoubanBlocked()) {
    console.log('Douban cooldown active, skipping request');
    return Promise.resolve(localResponse(429));
  }
  return throughGate(() => fetchDoubanOnce(url, options));
}

async function fetchDoubanOnce(
  url: string,
  options: RequestInit
): Promise<Response> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://movie.douban.com/',
    ...options.headers,
  };

  try {
    // 如果有缓存的 cookie，先尝试使用
    if (isCookieCacheValid()) {
      console.log('Trying with cached cookie...');
      const response = markRateLimited(
        await fetch(url, {
          ...options,
          headers: {
            ...headers,
            Cookie: cookieCache!.cookie,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      );

      if (response.ok) {
        console.log('Request succeeded with cached cookie');
        return response;
      }
      // 429 是限流不是 cookie 失效：不再匿名重试
      if (response.status === 429) return response;

      console.log('Cached cookie failed, will obtain new one');
      cookieCache = null;
    }

    // 尝试直接访问（不带 cookie）
    let response = markRateLimited(
      await fetch(url, {
        ...options,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );
    if (response.status === 429) return response;

    // 如果被重定向到验证页面，获取 cookie 后重试
    if (response.status === 302) {
      const location = response.headers.get('location');
      if (location && location.includes('sec.douban.com')) {
        console.log('Anti-crawler detected, obtaining cookie...');

        // 获取验证 cookie（会自动缓存）；验证流程里遇到 429 时 markRateLimited 已进入冷却，按限流回而不是抛错
        let cookie: string;
        try {
          cookie = await getDoubanCookie(url);
        } catch (error) {
          if (isDoubanBlocked()) return localResponse(429);
          throw error;
        }

        // 使用 cookie 重新请求
        response = markRateLimited(
          await fetch(url, {
            ...options,
            headers: {
              ...headers,
              Cookie: cookie,
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
        );
      }
    }

    return response;
  } catch (error) {
    console.error('Failed to fetch douban with verification:', error);
    throw error;
  }
}
