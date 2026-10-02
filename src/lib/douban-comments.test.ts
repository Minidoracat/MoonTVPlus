/**
 * @jest-environment <rootDir>/jest.node-fetch-env.js
 *
 * 豆瓣短评落地：三组会被无心重构打破的行为
 * 1. 闸门：任一 429 都进入冷却且不再匿名重试；冷却中排队的请求不出网
 * 2. 存储：半写入后重试不重加、不改序、count == 成员数；重抓更新内容
 * 3. 抓取状态机：同片串行按各自 needCount 补抓、过期首页清掉旧 exhausted、
 *    403 罚该片而全局冷却不罚、路由 503 与降级
 *
 * 每个 case jest.resetModules() 后重新 import，避免模块级状态（cookie 缓存、冷却、inflight）跨用例污染。
 * @/lib/db 必须 mock：next/jest 会载入 .env（kvrocks），真实 DbManager 会尝试连线。
 */

import type { RedisAdapter } from './redis-adapter';
import type { DoubanComment, DoubanCommentCacheMeta } from './types';

// ---------- 纯内存 Redis：只实现 dc:* 用到的 hash / zset ----------
class MemAdapter {
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  failZAddOnce: string | null = null; // 模拟 ZADD 该成员时中断
  failHSetOnce = false; // 模拟写内容（items hash）时中断

  async hSet(key: string, fieldOrData: string | Record<string, string>, value?: string) {
    if (this.failHSetOnce && key.endsWith(':items')) {
      this.failHSetOnce = false;
      throw new Error('simulated crash on HSET items');
    }
    const h = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, h);
    if (typeof fieldOrData === 'string') {
      h.set(fieldOrData, value ?? '');
      return 1;
    }
    for (const [f, v] of Object.entries(fieldOrData)) h.set(f, v);
    return Object.keys(fieldOrData).length;
  }
  async hGetAll(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async zAdd(key: string, member: { score: number; value: string }) {
    if (this.failZAddOnce === member.value) {
      this.failZAddOnce = null;
      throw new Error(`simulated crash on ZADD ${member.value}`);
    }
    const z = this.zsets.get(key) ?? new Map<string, number>();
    this.zsets.set(key, z);
    z.set(member.value, member.score);
    return 1;
  }
  async zRange(key: string, start: number, stop: number) {
    const all = Array.from(this.zsets.get(key) ?? [])
      .sort((a, b) => a[1] - b[1])
      .map(([v]) => v);
    return all.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async zCard(key: string) {
    return this.zsets.get(key)?.size ?? 0;
  }
}

const comment = (n: number, votes = n): DoubanComment => ({
  id: `c${n}`,
  userName: `u${n}`,
  userAvatar: '',
  userUrl: '',
  rating: 4,
  content: `content ${n}`,
  time: '2026-01-01 00:00:00',
  votes,
});

const baseMeta: Omit<DoubanCommentCacheMeta, 'count'> = {
  nextStart: 20,
  total: 0,
  exhausted: false,
  retryAfter: 0,
  fetchedAt: 1,
};

async function loadStorage() {
  jest.resetModules();
  jest.doMock('@/lib/db', () => ({ getStorage: () => null, db: {} }));
  jest.doMock('@/lib/config', () => ({ getConfig: async () => ({ SiteConfig: {} }) }));
  // user-cache 在模块顶层 setInterval，不 mock 会让 jest 挂着不退出
  jest.doMock('@/lib/user-cache', () => ({ userInfoCache: new Map(), ownerExistenceCache: new Map() }));
  const { BaseRedisStorage } = await import('./redis-base.db');
  const adapter = new MemAdapter();
  class MemStorage extends BaseRedisStorage {
    constructor() {
      // 测试用适配器只实现 dc:* 需要的方法；其余不会被调用
      super(adapter as unknown as RedisAdapter, (op) => op());
    }
  }
  return { storage: new MemStorage(), adapter };
}

// ---------- 豆瓣短评页 HTML ----------
function doubanPage(ids: number[], hasNext: boolean, votes: Record<number, number> = {}) {
  const items = ids
    .map(
      (id) =>
        `<div class="comment-item" data-cid="c${id}">` +
        `<div class="avatar"><a title="u${id}" href="https://www.douban.com/people/${id}/"><img src="https://img/${id}.jpg"></a></div>` +
        `<span class="comment-info"><span class="rating allstar40"></span><span class="comment-time" title="2026-01-01 00:00:00"></span></span>` +
        `<span class="votes vote-count">${votes[id] ?? id}</span><p><span class="short">content ${id}</span></p></div>`
    )
    .join('');
  const next = hasNext ? '<a href="?start=20&limit=20" class="next">后页</a>' : '';
  return `<html><body><h2>全部 ${ids.length * 3} 条</h2><div id="comments" class="mod-bd">${items}</div><div id="paginator">${next}</div></body></html>`;
}

describe('douban gate: 429 冷却与串行', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function loadGate(responses: Array<() => Response | Promise<Response>>) {
    jest.resetModules();
    const calls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch #${calls.length}: ${String(input)}`);
      return next();
    }) as unknown as typeof fetch;
    const mod = await import('./douban-anti-crawler');
    return { mod, calls };
  }

  const verificationHtml =
    '<form><input id="tok" value="t1"><input id="cha" value="c1"><input id="red" value="/r"></form>';
  const redirect = () =>
    new Response(null, { status: 302, headers: { location: 'https://sec.douban.com/c?r=x' } });

  test('cached-cookie 分支收到 429：进入冷却、不再匿名重试；排队中的请求不出网', async () => {
    // 第二次请求出网后先卡住（等豆瓣回应）；等它"已出网"的信号，再排入第三、四个请求，最后让它回 429
    let releaseSecond!: (r: Response) => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const { mod, calls } = await loadGate([
      redirect, // 直连 → 302
      redirect, // getDoubanCookie 第一步 → 302
      () => new Response(verificationHtml, { status: 200 }), // 验证页
      () => new Response(null, { status: 302, headers: { 'set-cookie': 'dbsawcv1=abc; Path=/' } }), // 提交 PoW
      () => new Response('<html>ok</html>', { status: 200 }), // 带 cookie 重试
      () => {
        markSecondStarted();
        return new Promise<Response>((resolve) => {
          releaseSecond = resolve;
        });
      },
    ]);

    const first = await mod.fetchDoubanWithVerification('https://movie.douban.com/subject/1/comments');
    expect(first.status).toBe(200);
    expect(calls).toHaveLength(5);

    const secondP = mod.fetchDoubanWithVerification('https://movie.douban.com/subject/2/comments');
    await secondStarted;
    const thirdP = mod.fetchDoubanWithVerification('https://movie.douban.com/subject/3/comments');
    const fourthP = mod.fetchDoubanWithVerification('https://movie.douban.com/subject/4/comments');
    releaseSecond(new Response(null, { status: 429 }));

    const second = await secondP;
    expect(second.status).toBe(429);
    expect(calls).toHaveLength(6); // cached cookie 直接 429，没有匿名 fallback
    expect(mod.isDoubanBlocked()).toBe(true);

    const [a, b] = await Promise.all([thirdP, fourthP]);
    expect([a.status, b.status]).toEqual([429, 429]);
    expect(a.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(a.headers.get('X-Douban-Gate')).toBe('cooldown');
    expect(calls).toHaveLength(6); // 入列在 429 之前的请求也一律不出网
  }, 20000);

  test('PoW 提交回 429（即使带 Set-Cookie）：不缓存 cookie、不抓目标页、进入冷却', async () => {
    const { mod, calls } = await loadGate([
      redirect, // 直连 → 302
      redirect, // getDoubanCookie 第一步 → 302
      () => new Response(verificationHtml, { status: 200 }),
      () => new Response(null, { status: 429, headers: { 'set-cookie': 'dbsawcv1=abc; Path=/' } }),
    ]);
    const res = await mod.fetchDoubanWithVerification('https://movie.douban.com/subject/9/comments');
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(4); // 没有带 cookie 去抓目标页
    expect(mod.isDoubanBlocked()).toBe(true);
    // 冷却中再来也不会用"缓存的 cookie"出网
    expect((await mod.fetchDoubanWithVerification('https://movie.douban.com/subject/9/comments')).status).toBe(429);
    expect(calls).toHaveLength(4);
  }, 20000);

  test('队列饱和：第 9 个并发请求直接回合成 503（saturated, Retry-After 30），不出网', async () => {
    let releaseFirst!: (r: Response) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const { mod, calls } = await loadGate([
      () => {
        markFirstStarted();
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      },
      ...Array.from({ length: 7 }, () => () => new Response('<html>ok</html>', { status: 200 })),
    ]);
    const inflight = Array.from({ length: 8 }, (_, i) =>
      mod.fetchDoubanWithVerification(`https://movie.douban.com/subject/${i}/`)
    );
    await firstStarted;
    const ninth = await mod.fetchDoubanWithVerification('https://movie.douban.com/subject/9/');
    expect(ninth.status).toBe(503);
    expect(ninth.headers.get('X-Douban-Gate')).toBe('saturated');
    expect(ninth.headers.get('Retry-After')).toBe(String(mod.GATE_SATURATED_RETRY_SECONDS));
    expect(calls).toHaveLength(1); // 第 9 个没有入列、没有出网

    // 放行第一个并让它回 429：排队的 7 个在算间隔前就被冷却短路，不等 1.5s×7，pending 也全部释放
    releaseFirst(new Response(null, { status: 429 }));
    const results = await Promise.all(inflight);
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(429));
    expect(calls).toHaveLength(1);
    // pending 已释放：冷却结束后再来一个不会再被 saturated 拒绝（此处只验 header 类型，不等冷却）
    expect((await mod.fetchDoubanWithVerification('https://movie.douban.com/subject/10/')).headers.get('X-Douban-Gate')).toBe('cooldown');
  }, 20000);
});

describe('BaseRedisStorage dc:*', () => {
  test('半写入后重试：不重加、顺序不变、count == 成员数', async () => {
    const { storage, adapter } = await loadStorage();
    await storage.appendDoubanComments('x', [comment(1), comment(2)], baseMeta);

    adapter.failZAddOnce = 'c3';
    await expect(
      storage.appendDoubanComments('x', [comment(3)], baseMeta)
    ).rejects.toThrow('simulated crash');
    // items 已有 c3、list 没有：读端看不到它，count 也不含它
    const broken = await storage.getDoubanCommentPage('x', 0, 10);
    expect(broken.comments.map((c) => c.id)).toEqual(['c1', 'c2']);

    const meta = await storage.appendDoubanComments(
      'x',
      [comment(1), comment(2), comment(3), comment(4)],
      baseMeta
    );
    const page = await storage.getDoubanCommentPage('x', 0, 10);
    expect(page.comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(meta.count).toBe(4);
    expect(await adapter.zCard('dc:x:list')).toBe(4);
  });

  test('写内容失败：不会留下无内容的公开成员，重试后可见数 == count', async () => {
    const { storage, adapter } = await loadStorage();
    await storage.appendDoubanComments('z', [comment(1)], baseMeta);
    adapter.failHSetOnce = true;
    await expect(
      storage.appendDoubanComments('z', [comment(2), comment(3)], baseMeta)
    ).rejects.toThrow('HSET');
    expect(await adapter.zCard('dc:z:list')).toBe(1); // 内容没写成，成员就不能公开
    const meta = await storage.appendDoubanComments('z', [comment(2), comment(3)], baseMeta);
    const page = await storage.getDoubanCommentPage('z', 0, 10);
    expect(page.comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(meta.count).toBe(page.comments.length);
  });

  test('重抓同一条：内容更新、不重复、分页稳定', async () => {
    const { storage } = await loadStorage();
    await storage.appendDoubanComments('y', [comment(1, 5), comment(2)], baseMeta);
    const meta = await storage.appendDoubanComments('y', [comment(1, 99), comment(3)], baseMeta);
    expect(meta.count).toBe(3);
    const p1 = await storage.getDoubanCommentPage('y', 0, 2);
    const p2 = await storage.getDoubanCommentPage('y', 2, 2);
    expect(p1.comments.map((c) => [c.id, c.votes])).toEqual([['c1', 99], ['c2', 2]]);
    expect(p2.comments.map((c) => c.id)).toEqual(['c3']);
  });
});

describe('ensureDoubanComments 状态机', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function loadLib(opts: { blocked?: () => boolean } = {}) {
    const { storage } = await loadStorage();
    // loadStorage 时 @/lib/db 的第一个 mock 已被 redis-base 的依赖链实例化，必须清掉注册表再换成真实 store
    jest.resetModules();
    jest.doMock('@/lib/db', () => ({ getStorage: () => storage, db: {} }));
    jest.doMock('@/lib/config', () => ({
      getConfig: async () => ({ SiteConfig: { EnableComments: true } }),
    }));
    const douban = jest.fn<Promise<Response>, [string]>();
    const blocked = opts.blocked ?? (() => false);
    // 只覆盖要拦的三个，其余（常量等）用真实实现，避免新增导出时 mock 静默变 undefined
    jest.doMock('@/lib/douban-anti-crawler', () => ({
      ...jest.requireActual('@/lib/douban-anti-crawler'),
      fetchDoubanWithVerification: douban,
      isDoubanBlocked: blocked,
      doubanCooldownSeconds: () => (blocked() ? 600 : 0),
    }));
    const lib = await import('./douban-comments');
    const route = await import('@/app/api/douban-comments/route');
    return { lib, route, storage, douban };
  }

  const html = (ids: number[], hasNext: boolean) => async () =>
    new Response(doubanPage(ids, hasNext), { status: 200 });
  const status = (code: number) => async () => new Response(null, { status: code });
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  test('冷启动补抓最多两页，续抓从 nextStart 接着走', async () => {
    const { lib, storage, douban } = await loadLib();
    douban
      .mockImplementationOnce(html(range(1, 20), true))
      .mockImplementationOnce(html(range(21, 20), true))
      .mockImplementationOnce(html(range(41, 20), true));

    const m1 = await lib.ensureDoubanComments('1', 60, true);
    expect(m1?.count).toBe(40); // 单次最多两页
    expect(douban).toHaveBeenCalledTimes(2);
    expect(douban.mock.calls[1][0]).toContain('start=20');

    const m2 = await lib.ensureDoubanComments('1', 60, false);
    expect(m2?.count).toBe(60);
    expect(douban.mock.calls[2][0]).toContain('start=40');
    expect((await storage.getDoubanCommentPage('1', 40, 20)).comments[0].id).toBe('c41');
  });

  test('同片并发：后到的更大 needCount 不会被前一个请求的结果吞掉', async () => {
    const { lib, douban } = await loadLib();
    douban
      .mockImplementationOnce(html(range(1, 20), true))
      .mockImplementationOnce(html(range(21, 20), true));

    const [a, b] = await Promise.all([
      lib.ensureDoubanComments('2', 20, true),
      lib.ensureDoubanComments('2', 40, false),
    ]);
    expect(a?.count).toBe(20);
    expect(b?.count).toBe(40);
    expect(douban).toHaveBeenCalledTimes(2);
  });

  test('首页过期重抓看到"后页"时清掉旧 exhausted，尾页重新可达', async () => {
    const { lib, storage, douban } = await loadLib();
    douban.mockImplementationOnce(html(range(1, 20), false)); // 当时只有 20 条
    const m1 = await lib.ensureDoubanComments('3', 20, true);
    expect(m1?.exhausted).toBe(true);
    // 8 天后
    await storage.appendDoubanComments('3', [], { ...m1!, fetchedAt: 1 });

    douban
      .mockImplementationOnce(html(range(1, 20), true)) // 首页刷新：现在有后页
      .mockImplementationOnce(html(range(21, 20), false));
    const m2 = await lib.ensureDoubanComments('3', 40, true);
    expect(m2?.exhausted).toBe(true); // 抓完第二页才真的到底
    expect(m2?.count).toBe(40);
    expect(douban).toHaveBeenCalledTimes(3);
  });

  test('首页过期时被闸门挡下：不写 meta、不动 retryAfter，本地照常可读', async () => {
    const { lib, storage, douban } = await loadLib();
    douban.mockImplementationOnce(html(range(1, 20), true));
    const m1 = await lib.ensureDoubanComments('3b', 20, true);
    await storage.appendDoubanComments('3b', [], { ...m1!, fetchedAt: 1 }); // 过期
    const append = jest.spyOn(storage, 'appendDoubanComments');

    douban.mockImplementationOnce(
      async () => new Response(null, { status: 503, headers: { 'X-Douban-Gate': 'saturated' } })
    );
    const m2 = await lib.ensureDoubanComments('3b', 40, true); // 本地不足，但闸门挡下就不该再试尾页
    expect(append).not.toHaveBeenCalled();
    expect(douban).toHaveBeenCalledTimes(2); // 首页那一次之后没有再出网
    expect(m2?.retryAfter).toBe(0);
    expect((await storage.getDoubanCommentPage('3b', 0, 20)).comments).toHaveLength(20);
  });

  test('失败分级：403 罚 12h；豆瓣本体 503 罚 1h；闸门合成 503/429 与途中进入冷却都不罚', async () => {
    const t0 = Date.now();
    const { lib, douban } = await loadLib();
    douban.mockImplementationOnce(status(403));
    const m403 = await lib.ensureDoubanComments('4', 20, true);
    expect(m403?.count).toBe(0);
    expect(m403!.retryAfter - t0).toBeGreaterThan(11 * 3600 * 1000);

    douban.mockImplementationOnce(status(503));
    const m503 = await lib.ensureDoubanComments('4b', 20, true);
    expect(m503!.retryAfter - t0).toBeGreaterThan(50 * 60 * 1000);
    expect(m503!.retryAfter - t0).toBeLessThan(2 * 3600 * 1000);

    douban.mockImplementationOnce(
      async () => new Response(null, { status: 503, headers: { 'X-Douban-Gate': 'saturated' } })
    );
    expect(await lib.ensureDoubanComments('4c', 20, true)).toBeNull(); // 闸门挡下：不写 meta

    // 请求发出后才进入冷却（另一片刚吃到 429）：该片同样不罚
    let blocked = false;
    const mid = await loadLib({ blocked: () => blocked });
    mid.douban.mockImplementationOnce(async () => {
      blocked = true;
      return new Response(null, { status: 429 });
    });
    expect(await mid.lib.ensureDoubanComments('5', 20, true)).toBeNull();
    expect(mid.douban).toHaveBeenCalledTimes(1);
  });

  test('合法空页 vs 登录墙：0 短评的片是成功（200 空列表），非短评页的 0 条是失败', async () => {
    const { lib, route, douban } = await loadLib();
    const { NextRequest } = await import('next/server');
    const get = (q: string) =>
      route.GET(new NextRequest(`http://localhost/api/douban-comments?${q}`));

    douban.mockImplementationOnce(html([], false)); // 有 #comments 容器但没有评论
    const empty = await get('id=11&start=0&limit=20');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ comments: [], hasMore: false });

    douban.mockImplementationOnce(
      async () => new Response('<html><body><form action="https://accounts.douban.com/login"></form></body></html>', { status: 200 })
    );
    const wall = await get('id=12&start=0&limit=20');
    expect(wall.status).toBe(503);
    expect((await lib.ensureDoubanComments('12', 20, false))?.retryAfter).toBeGreaterThan(Date.now());
  });

  test('尾页不满时游标只推进实际条数：评论增长后能从正确 offset 接上', async () => {
    const { lib, storage, douban } = await loadLib();
    douban
      .mockImplementationOnce(html(range(1, 20), true))
      .mockImplementationOnce(html(range(21, 5), false)); // 当时共 25 条
    const m1 = await lib.ensureDoubanComments('13', 40, true);
    expect(m1).toMatchObject({ count: 25, exhausted: true, nextStart: 25 });

    await storage.appendDoubanComments('13', [], { ...m1!, fetchedAt: 1 }); // 8 天后，评论长到 35
    douban
      .mockImplementationOnce(html(range(1, 20), true)) // 首页刷新：有后页 → 清 exhausted
      .mockImplementationOnce(html(range(26, 10), false)); // start=25 拿到新增的 26..35
    const m2 = await lib.ensureDoubanComments('13', 40, true);
    expect(douban.mock.calls[3][0]).toContain('start=25');
    expect(m2).toMatchObject({ count: 35, exhausted: true, nextStart: 35 });
  });

  test('路由：闸门饱和挡下且本地为空 → 503 带 Retry-After 30，不写 meta；罚期已过的旧失败记录同样回 30', async () => {
    const { lib, route, storage, douban } = await loadLib();
    const { NextRequest } = await import('next/server');
    const get = (id: string) =>
      route.GET(new NextRequest(`http://localhost/api/douban-comments?id=${id}&start=0&limit=20`));
    const saturated = async () =>
      new Response(null, { status: 503, headers: { 'X-Douban-Gate': 'saturated', 'Retry-After': '30' } });

    douban.mockImplementationOnce(saturated);
    const res = await get('14');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect((await storage.getDoubanCommentPage('14', 0, 0)).meta).toBeNull();

    // 曾 403 → 罚期到期 → 这次又被闸门挡下：不能回 Retry-After: 1
    douban.mockImplementationOnce(status(403));
    const failed = await lib.ensureDoubanComments('15', 20, true);
    await storage.appendDoubanComments('15', [], { ...failed!, retryAfter: Date.now() - 1000 });
    douban.mockImplementationOnce(saturated);
    const res2 = await get('15');
    expect(res2.status).toBe(503);
    expect(res2.headers.get('Retry-After')).toBe('30');
  });

  test('首页过期重抓拿到合法空页且无后页：exhausted=true，不再显示"加载更多"', async () => {
    const { lib, storage, douban } = await loadLib();
    douban.mockImplementationOnce(html(range(1, 20), true));
    const m1 = await lib.ensureDoubanComments('16', 20, true);
    expect(m1?.exhausted).toBe(false);
    await storage.appendDoubanComments('16', [], { ...m1!, fetchedAt: 1 }); // 过期

    douban.mockImplementationOnce(html([], false)); // 豆瓣把短评全撤了：合法空页、无后页
    const m2 = await lib.ensureDoubanComments('16', 20, true);
    expect(m2).toMatchObject({ exhausted: true, count: 20 });
    expect(douban).toHaveBeenCalledTimes(2);
  });

  test('登录墙式空页在全局冷却中不罚该片', async () => {
    let blocked = false;
    const { lib, douban } = await loadLib({ blocked: () => blocked });
    douban.mockImplementationOnce(async () => {
      blocked = true; // 请求期间别的片刚吃到 429
      return new Response('<html><body>login</body></html>', { status: 200 });
    });
    expect(await lib.ensureDoubanComments('17', 20, true)).toBeNull();
  });

  test('首次失败后恢复：走常规补抓，nextStart 正常推进、不重抓首页', async () => {
    const { lib, storage, douban } = await loadLib();
    douban.mockImplementationOnce(async () => { throw new Error('simulated timeout'); });
    const failed = await lib.ensureDoubanComments('8', 20, true);
    expect(failed?.fetchedAt).toBe(0);
    await storage.appendDoubanComments('8', [], { ...failed!, retryAfter: 0 }); // 罚期到

    douban
      .mockImplementationOnce(html(range(1, 20), true))
      .mockImplementationOnce(html(range(21, 20), true));
    const recovered = await lib.ensureDoubanComments('8', 20, true);
    expect(recovered?.nextStart).toBe(20);
    await lib.ensureDoubanComments('8', 40, false);
    expect(douban.mock.calls.map((c) => c[0].match(/start=(\d+)/)?.[1])).toEqual(['0', '0', '20']);
  });

  test('路由：从未成功 → 503；已有本地数据被拒 → 200 降级', async () => {
    const { lib, route, douban } = await loadLib();
    const { NextRequest } = await import('next/server');
    const get = (q: string) =>
      route.GET(new NextRequest(`http://localhost/api/douban-comments?${q}`));

    douban.mockImplementationOnce(status(404));
    expect((await get('id=6&start=0&limit=20')).status).toBe(503);

    douban.mockImplementationOnce(html(range(1, 20), true));
    const ok = await get('id=7&start=0&limit=20');
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.comments).toHaveLength(20);
    expect(body.hasMore).toBe(true);

    douban.mockImplementationOnce(status(403));
    const degraded = await get('id=7&start=20&limit=20');
    expect(degraded.status).toBe(200);
    const body2 = await degraded.json();
    expect(body2.comments).toHaveLength(0);
    expect(body2.hasMore).toBe(false);
    expect((await lib.ensureDoubanComments('7', 40, false))?.retryAfter).toBeGreaterThan(Date.now());
    expect(douban).toHaveBeenCalledTimes(3); // retryAfter 内不再出网
  });

  test('路由：冷却中且本地为空 → 429 带 Retry-After，不出网', async () => {
    const { route, douban } = await loadLib({ blocked: () => true });
    const { NextRequest } = await import('next/server');
    const res = await route.GET(
      new NextRequest('http://localhost/api/douban-comments?id=10&start=0&limit=20')
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(douban).not.toHaveBeenCalled();
  });
});
