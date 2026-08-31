import { searchTMDB } from '@/lib/tmdb.search';

import {
  __resetTitleCacheForTests,
  normalizeRegion,
  parseTsvChunks,
  parseTudumSeason,
  resolveTudumRows,
} from './netflix-top10';

// resolveTudumRows 的验证重点是「不丢列」与快取，不是 TMDB 的 HTTP 行为
jest.mock('@/lib/tmdb.search', () => ({
  searchTMDB: jest.fn(),
}));

const searchMock = searchTMDB as jest.MockedFunction<typeof searchTMDB>;

/** 把整份文字切成固定大小的 chunk，模拟串流读取的任意切点 */
function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function collect(text: string, size: number): string[][] {
  const rows: string[][] = [];
  parseTsvChunks(chunked(text, size), (c) => rows.push(c));
  return rows;
}

describe('parseTsvChunks', () => {
  // 官方档案结尾没有换行字元（实测 all-weeks-global.tsv 末位元组是 '1'）
  const noTrailingNewline =
    'week\tcategory\tweekly_rank\n' +
    '2026-07-26\tFilms (English)\t1\n' +
    '2026-07-19\tTV (Non-English)\t2';

  it.each([1, 2, 3, 7, 1024])(
    'chunk size %i：跳过表头、解析出 2 列、不吃掉没有换行的最后一列',
    (size) => {
      expect(collect(noTrailingNewline, size)).toEqual([
        ['2026-07-26', 'Films (English)', '1'],
        ['2026-07-19', 'TV (Non-English)', '2'],
      ]);
    }
  );

  it('有结尾换行时不会多吐一列空行', () => {
    expect(collect(noTrailingNewline + '\n', 5)).toEqual([
      ['2026-07-26', 'Films (English)', '1'],
      ['2026-07-19', 'TV (Non-English)', '2'],
    ]);
  });

  it('CRLF 与档案中间的空行都被丢掉', () => {
    const crlf = 'a\tb\r\n1\t2\r\n\r\n3\t4\r\n';
    expect(collect(crlf, 3)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('只有表头（且无结尾换行）时不吐任何列', () => {
    expect(collect('week\tcategory\tweekly_rank', 4)).toEqual([]);
  });

  it('保留空栏位：旧周的 runtime / weekly_views 是空字串，Number("") 会回 0 不是 NaN', () => {
    // 真实末行形状：...\t9140000\t\t\t1（weekly_hours_viewed 有值，runtime/weekly_views 为空）
    const tsv =
      'week\tcategory\tweekly_rank\tshow_title\tseason_title\t' +
      'weekly_hours_viewed\truntime\tweekly_views\tcumulative_weeks_in_top_10\n' +
      '2021-07-04\tTV (Non-English)\t10\tRecord of Ragnarok\t' +
      'Record of Ragnarok: Season 1\t9140000\t\t\t1';

    const rows = collect(tsv, 9);
    expect(rows).toHaveLength(1);
    const cols = rows[0];
    expect(cols).toHaveLength(9);
    expect(cols[6]).toBe(''); // runtime
    expect(cols[7]).toBe(''); // weekly_views
    expect(Number(cols[7])).toBe(0); // 陷阱本身：空字串不是 NaN
    expect(Number(cols[8]) || 0).toBe(1); // weeksInTop10 走 || 0 兜底
  });
});

describe('parseTudumSeason', () => {
  it('抽出季号', () => {
    expect(parseTudumSeason('Agent Kim Reactivated: Season 2')).toBe(2);
    expect(parseTudumSeason('Squid Game: Season 3')).toBe(3);
    expect(parseTudumSeason('Stranger Things: Part 4')).toBe(4);
    // 全形冒号（中文片名的 season_title 偶尔用）
    expect(parseTudumSeason('鱿鱼游戏：Season 2')).toBe(2);
  });

  it('无季号、限定剧、缺省一律回 null', () => {
    expect(parseTudumSeason('Elize: Shadows of a Woman')).toBeNull();
    // 限定剧不是「第 N 季」，加后缀会搜不到片源
    expect(
      parseTudumSeason('Agent Kim Reactivated: Limited Series')
    ).toBeNull();
    expect(parseTudumSeason('Record of Ragnarok: Season 1')).toBe(1); // 第 1 季不加后缀由呼叫端把关
    expect(parseTudumSeason(undefined)).toBeNull();
    expect(parseTudumSeason('')).toBeNull();
  });
});

describe('normalizeRegion', () => {
  it('合法地区原样通过（含两个全球伪地区）', () => {
    expect(normalizeRegion('JP')).toBe('JP');
    expect(normalizeRegion('global_nonen')).toBe('GLOBAL_NONEN');
    expect(normalizeRegion(' tw ')).toBe('TW');
  });

  it('非法或缺省一律回落台湾', () => {
    expect(normalizeRegion('XX')).toBe('TW');
    expect(normalizeRegion('')).toBe('TW');
    expect(normalizeRegion(null)).toBe('TW');
    expect(normalizeRegion(undefined)).toBe('TW');
  });
});

describe('resolveTudumRows', () => {
  const row = (rank: number, showTitle: string, seasonTitle?: string) => ({
    rank,
    showTitle,
    seasonTitle,
    weeksInTop10: 1,
  });

  const hit = (id: number, name: string) => ({
    code: 200,
    result: {
      id,
      name,
      title: name,
      poster_path: '/p.jpg',
      first_air_date: '2024-05-06',
      overview: '',
      vote_average: 8.25,
      media_type: 'tv' as const,
    },
  });

  const miss = { code: 404, result: null };

  beforeEach(() => {
    searchMock.mockReset();
    // titleCache 是模组层的，不清就会跨 case 污染：
    // 只要有人新增一个重用片名的 case，「只打一次 TMDB」的断言就会莫名其妙地过或不过
    __resetTitleCacheForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks(); // 否则 console.warn 每轮叠一层 spy 且永不还原
  });

  it('失配的列必须保留占位而不是被 filter 掉：名次靠阵列下标，丢一列就整份错位', async () => {
    const rows = [
      row(1, 'Miss Alpha'),
      row(2, 'Hit Bravo'),
      row(3, 'Miss Charlie'),
    ];
    searchMock.mockImplementation(async (_k, query) =>
      query === 'Hit Bravo' ? hit(11, '布拉沃') : miss
    );

    const list = await resolveTudumRows(rows, 'tv', 'key');

    expect(list).toHaveLength(3);
    expect(list.map((i) => i.title)).toEqual([
      'Miss Alpha',
      '布拉沃',
      'Miss Charlie',
    ]);
    // 失配项：保留英文原名当搜索词、id 留空（前端会转成 undefined 而非 tmdb_id=0）
    expect(list[0].id).toBe('');
    expect(list[0].query).toBe('Miss Alpha');
    // 每一项都得有非空 poster：getTMDBImageUrl(null) 回空字串会让 <Image> 破图
    expect(list.every((i) => i.poster.length > 0)).toBe(true);
    expect(list[0].poster.startsWith('data:image/svg+xml')).toBe(true);
    expect(list[1].poster).toBe('https://image.tmdb.org/t/p/w500/p.jpg');
    expect(list[1].rate).toBe('8.3');
    expect(list[1].year).toBe('2024');
  });

  it('第 2 季起在显示名补季号，query 保持纯剧名（资源站搜不到「第2季」）', async () => {
    searchMock.mockResolvedValue(hit(22, '金部长'));

    const list = await resolveTudumRows(
      [
        row(1, 'Season Two Show', 'Season Two Show: Season 2'),
        row(2, 'Season One Show', 'Season One Show: Season 1'),
        row(3, 'Limited Show', 'Limited Show: Limited Series'),
      ],
      'tv',
      'key'
    );

    expect(list.map((i) => i.title)).toEqual([
      '金部长 第2季',
      '金部长',
      '金部长',
    ]);
    expect(list.every((i) => i.query === '金部长')).toBe(true);
  });

  it('同名同类型只打一次 TMDB（模组层 titleCache 跨周跨地区共用）', async () => {
    searchMock.mockResolvedValue(hit(33, '缓存剧'));

    await resolveTudumRows([row(1, 'Cached Show')], 'tv', 'key');
    await resolveTudumRows([row(5, 'cached   show!!')], 'tv', 'key');

    expect(searchMock).toHaveBeenCalledTimes(1);
    // 已知类型走 typed endpoint，不是 search/multi
    expect(searchMock).toHaveBeenCalledWith(
      'key',
      'Cached Show',
      undefined,
      undefined,
      undefined,
      'tv'
    );
  });

  it('站点没设 TMDB Key：直接全部占位，不打 TMDB 也不写 negative cache', async () => {
    const list = await resolveTudumRows([row(1, 'No Key Show')], 'films', '');

    expect(searchMock).not.toHaveBeenCalled();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('No Key Show');
    expect(list[0].poster.startsWith('data:image/svg+xml')).toBe(true);

    // 之后后台补上 Key，同一部片必须立刻能查到（negative cache 没被污染）
    searchMock.mockResolvedValue(hit(44, '有钥匙了'));
    const retry = await resolveTudumRows([row(1, 'No Key Show')], 'films', 'k');
    expect(retry[0].title).toBe('有钥匙了');
  });
});
