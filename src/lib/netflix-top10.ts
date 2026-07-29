/* eslint-disable no-console */

import {
  NETFLIX_TOP10_DEFAULT_REGION,
  NETFLIX_TOP10_REGIONS,
  NetflixTop10Kind,
  NetflixTop10Manifest,
  NetflixTop10Row,
  NetflixWeekSnapshot,
} from '@/lib/netflix.client';
import { getTMDBImageUrl, searchTMDB } from '@/lib/tmdb.search';
import { DoubanItem } from '@/lib/types';

// 型别定义在 client-safe 的 netflix.client.ts（UI 也要用地区表），这里转出一份，
// 让服务端 consumer 只 import 这一个模组。
export type {
  NetflixTop10Kind,
  NetflixTop10Manifest,
  NetflixTop10Row,
  NetflixWeekSnapshot,
};

const GLOBAL_TSV =
  'https://www.netflix.com/tudum/top10/data/all-weeks-global.tsv';
const COUNTRIES_TSV =
  'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';

const MANIFEST_KEY = 'netflix:top10:manifest';
const weekKey = (week: string) => `netflix:top10:week:${week}`;

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 官方周二发布，6 小时探一次
const FETCH_TIMEOUT_MS = 180 * 1000; // 实测 31MB 下载约 33s，留足余量
// ponytail: 全存 265 周约 5.3MB / 265 把 key，首轮一次性写入，之后每周只写 1 把。
//           真要压缩就设这个环境变量；不设 = 全存。
const KEEP_WEEKS = Number(process.env.NETFLIX_TOP10_KEEP_WEEKS || '0');
// ponytail: Cloudflare 免费版 10ms CPU 撑不住 49 万列，设 off 只吃 868KB 的 global 档，
//           地区选单会依 manifest.regions 自动收敛成只剩两个全球榜，不需要另写降级 UI。
const COUNTRIES_ENABLED = process.env.NETFLIX_TOP10_COUNTRIES !== 'off';

const REGION_CODES = new Set(NETFLIX_TOP10_REGIONS.map((r) => r.value));
const COUNTRY_CODES = new Set(
  NETFLIX_TOP10_REGIONS.map((r) => r.value).filter(
    (v) => !v.startsWith('GLOBAL_')
  )
);
// global 档的 category -> [伪地区, kind]。四个 category 是两份独立 Top10，
// 合并会出现两个 #1，所以拆成 GLOBAL_EN / GLOBAL_NONEN 两个伪地区。
const GLOBAL_CATEGORY: Record<string, [string, NetflixTop10Kind]> = {
  'Films (English)': ['GLOBAL_EN', 'films'],
  'TV (English)': ['GLOBAL_EN', 'tv'],
  'Films (Non-English)': ['GLOBAL_NONEN', 'films'],
  'TV (Non-English)': ['GLOBAL_NONEN', 'tv'],
};

// ---------- 存取（localstorage 模式下 db.storage 为 null，取属性会 TypeError） ----------

let memManifest: NetflixTop10Manifest | null = null;
const memWeeks = new Map<string, NetflixWeekSnapshot>();

// 265 周全留在记忆体约 6.4 万个 row 物件（~20MB heap），而 UI 一次只看一周。
// 只留最近用到的几周，其余交给 getNetflixTop10Rows 的 lazy 读路径。
const MEM_WEEKS_MAX = 8;

/** 写入并按插入顺序淘汰最旧的（Map 保留插入序，够用不需要真 LRU） */
function rememberWeek(week: string, snapshot: NetflixWeekSnapshot): void {
  memWeeks.delete(week); // 重新插入到队尾，避免刚写的又被当成最旧的淘汰
  memWeeks.set(week, snapshot);
  while (memWeeks.size > MEM_WEEKS_MAX) {
    const oldest = memWeeks.keys().next().value;
    if (oldest === undefined) break;
    memWeeks.delete(oldest);
  }
}

// db.ts:1194 的 `export const db = new DbManager()` 在 import 当下就会建立 kvrocks 连线，
// 延迟到真的要读写才载入，纯解析逻辑的单元测试才不会拉起一条 redis 连线。
async function getDb() {
  return (await import('@/lib/db')).db;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await getDb()).getGlobalValue(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // localstorage 模式无 storage 实例（db.ts:82-84），退化成纯记忆体快取
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await (await getDb()).setGlobalValue(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[netflix-top10] 持久化失败，仅保留记忆体快取:', err);
  }
}

// ---------- TSV 解析 ----------

/**
 * 逐块喂入的 TSV 行解析器。首行（表头）自动跳过。
 * end() 必须呼叫：官方档案结尾没有换行字元（已实测），最后一列只会留在 buf 里。
 */
function createTsvParser(onRow: (cols: string[]) => void) {
  let buf = '';
  let headerSkipped = false;

  const emit = (line: string) => {
    const row = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!row) return;
    if (!headerSkipped) {
      headerSkipped = true;
      return;
    }
    onRow(row.split('\t'));
  };

  const drain = () => {
    let start = 0;
    let nl = buf.indexOf('\n', start);
    while (nl !== -1) {
      emit(buf.slice(start, nl));
      start = nl + 1;
      nl = buf.indexOf('\n', start);
    }
    buf = buf.slice(start);
  };

  return {
    push(chunk: string) {
      buf += chunk;
      drain();
    },
    end() {
      if (buf) emit(buf);
      buf = '';
    },
  };
}

/** 把已切好的 chunk 序列喂进行解析器，供测试用（真档没有结尾换行） */
export function parseTsvChunks(
  chunks: string[],
  onRow: (cols: string[]) => void
): void {
  const parser = createTsvParser(onRow);
  chunks.forEach((chunk) => parser.push(chunk));
  parser.end();
}

/**
 * 逐行串流 TSV。31MB 档不可整份进记忆体（await res.text() 实测 heapUsed 70MB+）。
 * 用 getReader() 而非 for-await：DOM 的 ReadableStream 型别未标 async-iterable，
 * 且 Workers 的实作确实不可迭代。
 */
async function streamTsv(
  url: string,
  onRow: (cols: string[]) => void
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'text/tab-separated-values,*/*',
      },
    });
    if (!res.ok) {
      // undici 下未消费的 body 会让连线挂着到 GC —— 对 31MB 的端点值得处理
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Netflix Top10 抓取失败: ${res.status} ${url}`);
    }
    if (!res.body) throw new Error('Netflix Top10 回应没有 body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = createTsvParser(onRow);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream:true 才不会切坏跨 chunk 的多位元组字元
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Ingest ----------

const season = (v?: string) => (v && v !== 'N/A' ? v : undefined);

function bucket(
  weeks: Map<string, NetflixWeekSnapshot>,
  week: string,
  region: string,
  kind: NetflixTop10Kind
): NetflixTop10Row[] {
  let snapshot = weeks.get(week);
  if (!snapshot) {
    snapshot = { week, regions: {} };
    weeks.set(week, snapshot);
  }
  if (!snapshot.regions[region])
    snapshot.regions[region] = { films: [], tv: [] };
  return snapshot.regions[region][kind];
}

async function ingest(): Promise<NetflixTop10Manifest> {
  const previous = await getManifest();
  const weeks = new Map<string, NetflixWeekSnapshot>();

  // 1) global 档（868KB）。它同时是资料来源与「有无新一周」的探针 ——
  //    官方 HEAD 回 405、无 ETag、If-Modified-Since 回 200、Range 被忽略（全部实测），
  //    没有更便宜的探针可用。
  // 栏位序：week/category/weekly_rank/show_title/season_title/
  //         weekly_hours_viewed/runtime/weekly_views/cumulative_weeks_in_top_10
  //    注意 2023-06-18 之前的列 runtime/weekly_views 是空字串，Number('') 回 0 不是 NaN，
  //    所以只取本设计真的会用到的 cumulative（|| 0 兜底）。
  await streamTsv(GLOBAL_TSV, (c) => {
    const target = GLOBAL_CATEGORY[c[1]];
    if (!target) return;
    bucket(weeks, c[0], target[0], target[1]).push({
      rank: Number(c[2]),
      showTitle: c[3],
      seasonTitle: season(c[4]),
      weeksInTop10: Number(c[8]) || 0,
    });
  });

  const allWeeks = Array.from(weeks.keys()).sort().reverse();
  const latestWeek = allWeeks[0];
  if (!latestWeek) throw new Error('Netflix Top10 global 档案没有可用资料');

  // 2) 没有新一周就到此为止，省下 31MB。
  //    但 writeJson 会把持久化失败吞成 warn，manifest 写成功、周快照写失败是可能的；
  //    此时若无条件早退，该周永远不会被重写，功能要等下一个新周（最长 7 天）才自愈。
  //    countriesOk 为 false 代表上轮 31MB 没抓成，也必须走完整流程重试。
  //
  // 走到 3) 而 latestWeek 没变 = 复原轮（快照缺失或上轮 countries 失败）。
  // 这些周已在 manifest.weeks 里，下方写入必须绕过 known 判断强制重写。
  let isRecovery = false;
  if (previous && previous.latestWeek === latestWeek) {
    const snapshotAlive =
      memWeeks.has(latestWeek) || Boolean(await readJson(weekKey(latestWeek)));
    if (snapshotAlive && previous.countriesOk !== false) {
      const next = { ...previous, checkedAt: Date.now() };
      await writeJson(MANIFEST_KEY, next);
      memManifest = next;
      return next;
    }
    isRecovery = true;
  }

  // 3) 有新一周才付 31MB 代价。栏位序：
  //    country_name/country_iso2/week/category/weekly_rank/show_title/
  //    season_title/cumulative_weeks_in_top_10（没有观看数）
  //    31MB 在弱网/代理下失败不罕见，但此时 868KB 的 global 档已经解析完毕、
  //    两个全球榜完全可用。单独 try/catch 才不会因为 countries 失败就把它一起丢掉。
  let countriesOk = true;
  if (COUNTRIES_ENABLED) {
    try {
      // 以 global 档的周次为准：countries 档若含 global 没有的周，那些周不会进
      // allWeeks/keptWeeks，解析进来只会占记忆体却永远不落地、不可查
      const globalWeeks = new Set(allWeeks);
      await streamTsv(COUNTRIES_TSV, (c) => {
        if (!COUNTRY_CODES.has(c[1])) return; // 白名单：94 国只留 10 国
        if (!globalWeeks.has(c[2])) return;
        bucket(weeks, c[2], c[1], c[3] === 'Films' ? 'films' : 'tv').push({
          rank: Number(c[4]),
          showTitle: c[5],
          seasonTitle: season(c[6]),
          weeksInTop10: Number(c[7]) || 0,
        });
      });
    } catch (err) {
      countriesOk = false;
      console.warn('Netflix Top10 各国榜抓取失败，本轮只落地全球榜:', err);
    }
  }

  // countries 半途失败可能留下不完整的地区列表，整周丢弃重来比落地半份榜单干净
  if (!countriesOk) {
    Array.from(weeks.values()).forEach((snapshot) => {
      Object.keys(snapshot.regions).forEach((region) => {
        if (!region.startsWith('GLOBAL_')) delete snapshot.regions[region];
      });
    });
  }

  const keptWeeks = KEEP_WEEKS > 0 ? allWeeks.slice(0, KEEP_WEEKS) : allWeeks;
  const known = new Set(previous?.weeks || []);
  const regionSet = new Set<string>();

  for (let index = 0; index < keptWeeks.length; index++) {
    const week = keptWeeks[index];
    const snapshot = weeks.get(week) as NetflixWeekSnapshot;
    Object.entries(snapshot.regions).forEach(([region, lists]) => {
      regionSet.add(region);
      lists.films.sort((a, b) => a.rank - b.rank);
      lists.tv.sort((a, b) => a.rank - b.rank);
    });
    // 旧周内容永不变动：正常情况只写 manifest 里没有的周，
    // 首轮 265 次写入是一次性成本，之后每周只写 1 把。
    //
    // 但「复原轮」必须强制重写：上一轮 countries 失败时落地的是 global-only 快照，
    // 而该周已经在 manifest.weeks 里 —— 只靠 known 判断会跳过写入，
    // 于是行程内的 memWeeks 看起来是好的、重启后读回的却仍是缺各国榜的旧快照。
    if (isRecovery || !known.has(week)) await writeJson(weekKey(week), snapshot);
    // keptWeeks 是新到旧，只记忆体快取最前面几周（逐周 remember 会让最旧的留下来）
    if (index < MEM_WEEKS_MAX) rememberWeek(week, snapshot);
  }

  // 滚出保留窗口的旧周清掉（KEEP_WEEKS 未设时这里是空集合）
  const keptSet = new Set(keptWeeks);
  for (const stale of (previous?.weeks || []).filter((w) => !keptSet.has(w))) {
    memWeeks.delete(stale);
    try {
      await (await getDb()).deleteGlobalValue(weekKey(stale));
    } catch {
      /* localstorage 模式无持久化，忽略 */
    }
  }

  const now = Date.now();
  const next: NetflixTop10Manifest = {
    weeks: keptWeeks,
    latestWeek,
    regions: NETFLIX_TOP10_REGIONS.map((r) => r.value).filter((c) =>
      regionSet.has(c)
    ),
    countriesOk,
    updatedAt: now,
    checkedAt: now,
  };
  await writeJson(MANIFEST_KEY, next);
  memManifest = next;
  return next;
}

// ---------- 併发去重 + cron 入口 ----------

// 行程内 in-flight 去重。不可用 lockManager：src/lib/lock.ts:6 的 LOCK_TIMEOUT 写死 10 秒，
// 会在 31MB 还没下载完时自动释放并让排队者 reject。沿用 web-push.ts:37-58 的 promise slot。
// ponytail: 只保证单行程不重抓。目前 docker-compose 单容器；扩到多副本时再加一把
//           netflix:top10:lock 时间戳当跨行程门槛。
const INGEST_KEY = Symbol.for('__MOONTV_NETFLIX_TOP10_INGEST__');

// 用具名型别取代散落的 (globalThis as any)，省掉整档的 no-explicit-any disable
type IngestSlot = {
  [INGEST_KEY]?: Promise<NetflixTop10Manifest>;
};
const slot = globalThis as unknown as IngestSlot;

export function ingestNetflixTop10(): Promise<NetflixTop10Manifest> {
  const running = slot[INGEST_KEY];
  if (running) return running;

  const promise = ingest()
    .catch(async (err) => {
      // 失败也要记 checkedAt，否则每小时 cron 会反覆重抓。
      // 首次抓取就失败时 previous 为 null，必须落一笔空 manifest 当退避墓碑，
      // 否则 refreshNetflixTop10 的 6 小时 gate 永远拿不到 checkedAt，
      // 且每个请求都会从 getNetflixTop10Rows 再点火一轮 ingest。
      const previous = await getManifest();
      const next: NetflixTop10Manifest = previous
        ? { ...previous, checkedAt: Date.now() }
        : {
            weeks: [],
            latestWeek: '',
            regions: [],
            updatedAt: 0,
            checkedAt: Date.now(),
          };
      await writeJson(MANIFEST_KEY, next);
      memManifest = next;
      throw err;
    })
    .finally(() => {
      delete slot[INGEST_KEY];
    });

  slot[INGEST_KEY] = promise;
  return promise;
}

/** cron 呼叫：自我 gate，距上次检查不足 6 小时直接 return */
export async function refreshNetflixTop10(): Promise<void> {
  try {
    const manifest = await getManifest();
    if (manifest && Date.now() - manifest.checkedAt < REFRESH_INTERVAL_MS) {
      console.log('跳过 Netflix Top10 刷新：距上次检查不足 6 小时');
      return;
    }
    const next = await ingestNetflixTop10();
    console.log(
      `Netflix Top10 已更新：最新周 ${next.latestWeek}，共 ${next.weeks.length} 周，地区 ${next.regions.length} 个`
    );
  } catch (err) {
    console.error('Netflix Top10 刷新失败:', err);
  }
}

// ---------- 读取 ----------

export async function getManifest(): Promise<NetflixTop10Manifest | null> {
  if (memManifest) return memManifest;
  memManifest = await readJson<NetflixTop10Manifest>(MANIFEST_KEY);
  return memManifest;
}

export function normalizeRegion(input?: string | null): string {
  const code = (input || '').trim().toUpperCase();
  return REGION_CODES.has(code) ? code : NETFLIX_TOP10_DEFAULT_REGION;
}

/** 回传该周该地区该类别的 10 列原始榜单（英文片名） */
export async function getNetflixTop10Rows(query: {
  region: string;
  kind: NetflixTop10Kind;
  week?: string;
}): Promise<{
  week: string;
  weeks: string[];
  regions: string[];
  rows: NetflixTop10Row[];
  pending: boolean;
}> {
  const manifest = await getManifest();
  if (!manifest || !manifest.latestWeek) {
    // 冷启动：绝不 await 31MB（首轮约 40 秒会把请求卡死），背景拉取后由前端重试。
    // 上一轮失败会留下 checkedAt 墓碑，据此退避——否则每个请求都点火一轮抓取。
    if (!manifest || Date.now() - manifest.checkedAt >= REFRESH_INTERVAL_MS) {
      ingestNetflixTop10().catch((err) =>
        console.error('Netflix Top10 冷启动拉取失败:', err)
      );
    }
    return { week: '', weeks: [], regions: [], rows: [], pending: true };
  }

  const week =
    query.week && manifest.weeks.includes(query.week)
      ? query.week
      : manifest.latestWeek;

  let snapshot = memWeeks.get(week) || null;
  if (!snapshot) {
    snapshot = await readJson<NetflixWeekSnapshot>(weekKey(week));
    if (snapshot) rememberWeek(week, snapshot);
  }

  // manifest 有该周、快照却读不到（写入失败或被清掉）：此路径不属于冷启动，
  // 上面的点火分支不会走到，不补一道就会永远卡在 pending 直到下一个新周。
  if (!snapshot && Date.now() - manifest.checkedAt >= REFRESH_INTERVAL_MS) {
    ingestNetflixTop10().catch((err) =>
      console.error('Netflix Top10 周快照缺失，补拉失败:', err)
    );
  }

  return {
    week,
    weeks: manifest.weeks,
    regions: manifest.regions,
    rows: snapshot?.regions[query.region]?.[query.kind] ?? [],
    pending: !snapshot,
  };
}

// ---------- TMDB 片名映射（英文片名 -> 中文名/海报/tmdb_id） ----------

// 映射只与「片名 + 类型」有关，与国家/周次无关 -> 跨国跨周共用。
// ponytail: 行程内 Map，多副本各存一份；命中率够用，要跨行程再落 kvrocks。
const titleCache = new Map<
  string,
  { item: DoubanItem | null; expires: number }
>();
const TITLE_TTL = 7 * 24 * 60 * 60 * 1000; // 中文名基本不变
const TITLE_NEGATIVE_TTL = 12 * 60 * 60 * 1000; // 失配短快取，等 TMDB 补条目
const TITLE_CACHE_MAX = 2000;

// getTMDBImageUrl(null) 回空字串，而 VideoCard 的 <Image src=''> 会破图
// （VideoCard.tsx:995，只有 netdisk 来源才有 placeholder 分支）
const MISSING_POSTER = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600"><rect width="400" height="600" fill="#f3f4f6"/><text x="200" y="330" text-anchor="middle" font-size="140" fill="#d1d5db" font-family="sans-serif">N</text></svg>'
)}`;

/** "Agent Kim Reactivated: Season 2" -> 2；无季号回 null */
export function parseTudumSeason(seasonTitle?: string): number | null {
  const m = /[:：]\s*(?:Season|Part)\s+(\d{1,2})\s*$/i.exec(seasonTitle || '');
  return m ? Number(m[1]) : null;
}

function normalizeTitle(name?: string | null): string {
  const raw = (name || '').trim().toLowerCase();
  // 只留字母/数字/汉字；全被剥光时（例如纯谚文片名）退回原字串，
  // 否则两部不同的片会共用同一把空字串 key 而互相污染快取。
  return raw.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '') || raw;
}

/** 仅供测试：titleCache 是模组层的，不清会跨 case 污染「只打一次 TMDB」这类断言 */
export function __resetTitleCacheForTests(): void {
  titleCache.clear();
}

function setTitleCache(key: string, item: DoubanItem | null) {
  if (titleCache.size >= TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next().value;
    if (oldest !== undefined) titleCache.delete(oldest);
  }
  titleCache.set(key, {
    item,
    expires: Date.now() + (item ? TITLE_TTL : TITLE_NEGATIVE_TTL),
  });
}

/** 失配占位：保留英文原名与占位海报，点进去仍会用英文搜一次 */
function placeholderItem(row: NetflixTop10Row): DoubanItem {
  return {
    id: '',
    title: row.showTitle,
    query: row.showTitle,
    poster: MISSING_POSTER,
    rate: '',
    year: '',
  };
}

/**
 * 把榜单行映射成 VideoCard 能直接吃的 DoubanItem。
 * 名次由阵列顺序表达，失配项**保留占位而不丢弃** —— 丢弃会让前端的
 * index+1 名次静默错位（第 3 名显示成 #2）。
 * 这与 tmdb.client.ts:536 `getTMDBHotList` 的 `.filter(item => item.title && item.poster)`
 * 是刻意相反的行为。
 */
export async function resolveTudumRows(
  rows: NetflixTop10Row[],
  kind: NetflixTop10Kind,
  apiKey: string,
  proxy?: string,
  reverseProxy?: string
): Promise<DoubanItem[]> {
  // 没有 Key 就不打 TMDB，也不写 negative cache（否则之后设好 Key，12 小时内还是英文名）
  if (!apiKey) return rows.map(placeholderItem);

  const mediaType = kind === 'films' ? 'movie' : 'tv';

  // 一次只有 10 行，直接 Promise.all；TMDB 限速 ~50 req/s，够用
  const mapped = await Promise.all(
    rows.map(async (row) => {
      const cacheKey = `${mediaType}:${normalizeTitle(row.showTitle)}`;
      const cached = titleCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) return cached.item;

      // 用 show_title 而非 season_title：": Season 2" 后缀会打乱 TMDB 匹配
      const { code, result } = await searchTMDB(
        apiKey,
        row.showTitle,
        proxy,
        undefined,
        reverseProxy,
        mediaType
      ).catch(() => ({ code: 500, result: null }));

      if (!result) {
        console.warn(
          '[NetflixTop10] TMDB 未命中:',
          mediaType,
          row.showTitle,
          `code=${code}`
        );
        // 只有「查得到但真的没有这部片」才写 12 小时负快取。
        // timeout / 429 / 5xx 是暂时性的，写进去会让 TMDB 恢复后半天内还是英文占位。
        if (code === 200) setTitleCache(cacheKey, null);
        return null;
      }

      const item: DoubanItem = {
        id: String(result.id),
        title: result.title || result.name || row.showTitle,
        query: result.title || result.name || row.showTitle,
        poster: getTMDBImageUrl(result.poster_path) || MISSING_POSTER,
        rate: result.vote_average ? result.vote_average.toFixed(1) : '',
        year: (result.release_date || result.first_air_date || '').slice(0, 4),
      };
      setTitleCache(cacheKey, item);
      return item;
    })
  );

  return mapped.map((item, i) => {
    const row = rows[i];
    // rank 带的是官方名次而非阵列下标：同一部片在不同地区名次不同，
    // 所以只能在这层套用（titleCache 里的 item 是跨地区共用的，不能写进去）
    if (!item) return { ...placeholderItem(row), rank: row.rank };

    // 显示名带季号（第 2 季起才加），搜索词 query 保持纯剧名 ——
    // /play 的 fetchSourcesData 打 /api/search 时没带 alias=1（play/page.tsx:4739），
    // 搜索词必须是资源站认得的干净中文名
    const seasonNo = parseTudumSeason(row.seasonTitle);
    const titled =
      seasonNo && seasonNo > 1
        ? { ...item, title: `${item.title} 第${seasonNo}季` }
        : item;
    return { ...titled, rank: row.rank };
  });
}
