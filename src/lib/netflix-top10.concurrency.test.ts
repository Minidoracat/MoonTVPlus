/**
 * ingestNetflixTop10 的併发去重与失败退避。
 *
 * 这两条是全案唯一能造成「每个请求点火一轮 31MB 下载」的路径，
 * 却最容易被无心重构打破（去重依赖「呼叫 ingest 与写 globalThis slot 在同一同步区块」
 * 这个不变式）。用真实的 fetch mock 走完整条 ingest，不 mock 内部函式。
 *
 * 每个 case 都 jest.resetModules() + 重新 import，避免模组层的
 * memManifest / memWeeks / globalThis slot 跨测试污染。
 */

export {}; // isolatedModules：本档没有 import，需显式标记为 module

// jsdom 环境没有 TextDecoder/TextEncoder，而 streamTsv 依赖它们解码分块
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof global.TextDecoder === 'undefined') {
  (global as Record<string, unknown>).TextDecoder = NodeTextDecoder;
}
if (typeof global.TextEncoder === 'undefined') {
  (global as Record<string, unknown>).TextEncoder = NodeTextEncoder;
}

const GLOBAL_TSV = [
  'week\tcategory\tweekly_rank\tshow_title\tseason_title\tweekly_hours_viewed\truntime\tweekly_views\tcumulative_weeks_in_top_10',
  '2026-07-26\tFilms (English)\t1\t72 HOURS\t\t100\t1:30\t22100000\t1',
].join('\n');

/** 只回 global 档的 fetch；countries 档不参与（测试只关心控制流） */
function okFetch() {
  return jest.fn(async (url: string) => {
    if (!String(url).includes('all-weeks-global')) {
      throw new Error('countries 档在本测试中不参与');
    }
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              return {
                done: false,
                value: new TextEncoder().encode(GLOBAL_TSV),
              };
            },
            releaseLock() {
              /* noop */
            },
          };
        },
      },
    };
  });
}

function failFetch() {
  return jest.fn(async (_url: string) => {
    throw new Error('network down');
  });
}

/**
 * 重新载入受测模组，并把 db 换成纯记忆体 stub。
 * 不 stub 的话 getDb() 的动态 import 会拉起真实 DbManager 并尝试连线 kvrocks（测试会卡死）。
 */
async function loadModule(fetchMock: jest.Mock) {
  jest.resetModules();
  process.env.NETFLIX_TOP10_COUNTRIES = 'off'; // 只走 868KB 那条路径
  const store = new Map<string, unknown>();
  jest.doMock('@/lib/db', () => ({
    db: {
      getGlobalValue: async (k: string) => store.get(k) ?? null,
      setGlobalValue: async (k: string, v: unknown) => void store.set(k, v),
      deleteGlobalValue: async (k: string) => void store.delete(k),
    },
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  const mod = await import('./netflix-top10');
  return { mod, store };
}

describe('ingestNetflixTop10 併发去重', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NETFLIX_TOP10_COUNTRIES;
    jest.clearAllMocks();
  });

  it('同时呼叫两次只触发一轮抓取（in-flight slot 生效）', async () => {
    const fetchMock = okFetch();
    const { mod } = await loadModule(fetchMock);

    const [a, b] = await Promise.all([
      mod.ingestNetflixTop10(),
      mod.ingestNetflixTop10(),
    ]);

    // 两个呼叫拿到同一个 manifest，且 global 档只被下载一次
    expect(a).toBe(b);
    expect(a.latestWeek).toBe('2026-07-26');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('首次抓取失败的退避墓碑', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NETFLIX_TOP10_COUNTRIES;
    jest.clearAllMocks();
  });

  it('失败后 getNetflixTop10Rows 不再点火，否则每个请求都会重抓 31MB', async () => {
    const fetchMock = failFetch();
    const { mod, store } = await loadModule(fetchMock);

    // 首轮失败：此时没有 previous manifest 可 spread，必须自己落一笔空墓碑
    await expect(mod.ingestNetflixTop10()).rejects.toThrow('network down');
    const attemptsAfterIngest = fetchMock.mock.calls.length;
    expect(attemptsAfterIngest).toBeGreaterThan(0);

    // 墓碑生效：后续请求回 pending 但不再触发抓取
    for (let i = 0; i < 3; i++) {
      const res = await mod.getNetflixTop10Rows({ region: 'TW', kind: 'films' });
      expect(res.pending).toBe(true);
      expect(res.rows).toEqual([]);
    }
    // 等待可能被 fire-and-forget 排上的 microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(attemptsAfterIngest);

    // 墓碑必须真的落进 KV：只验行程内的 memManifest 的话，
    // 就算持久化整个没写也会通过，重启后又会回到每请求点火
    const raw = store.get('netflix:top10:manifest');
    expect(typeof raw).toBe('string'); // writeJson 存的是 JSON 字串
    const persisted = JSON.parse(raw as string) as {
      checkedAt: number;
      latestWeek: string;
    };
    expect(persisted.latestWeek).toBe('');
    expect(persisted.checkedAt).toBeGreaterThan(0);
  });
});

describe('串流解码：真实 byte 层跨块', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NETFLIX_TOP10_COUNTRIES;
    jest.clearAllMocks();
  });

  // parseTsvChunks 吃的是 string，测不到 TextDecoder 那层。
  // 中文片名的 UTF-8 是 3 bytes，逐 byte 喂才会真的踩到跨块解码。
  it('多字节片名被逐 byte 切开仍能正确还原', async () => {
    const tsv = [
      'week\tcategory\tweekly_rank\tshow_title\tseason_title\tweekly_hours_viewed\truntime\tweekly_views\tcumulative_weeks_in_top_10',
      '2026-07-26\tFilms (English)\t1\t鬼灭之刃：无限城篇\t\t100\t1:30\t22100000\t3',
    ].join('\n');
    const bytes = new TextEncoder().encode(tsv);

    const fetchMock = jest.fn(async (url: string) => {
      if (!String(url).includes('all-weeks-global')) {
        throw new Error('countries 档在本测试中不参与');
      }
      let i = 0;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (i >= bytes.length) return { done: true, value: undefined };
              // 一次只吐 1 byte：多字节字元必然被切断
              return { done: false, value: bytes.slice(i, ++i) };
            },
            releaseLock() {
              /* noop */
            },
          }),
        },
      };
    });

    const { mod } = await loadModule(fetchMock);
    await mod.ingestNetflixTop10();
    const res = await mod.getNetflixTop10Rows({
      region: 'GLOBAL_EN',
      kind: 'films',
    });

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].showTitle).toBe('鬼灭之刃：无限城篇');
    expect(res.rows[0].weeksInTop10).toBe(3);
  });
});
