/**
 * 搜尋結果顯示邏輯的不變式。
 *
 * 這五條每一條退化都不會有任何東西「壞掉」—— 畫面仍然畫得出結果，只是
 * 順序不對、篩選沒套上，或悄悄改到 React state。而其中兩條是這一輪靠
 * 人眼推演＋瀏覽器實測才發現的：
 *   - 串流期間 buckets 必須維持插入順序（否則 chip 重排會把 click 吞掉）
 *   - 排序不得就地改動傳入的 results（否則改到 state 而 React 比對不出來）
 */

import type { MangaSearchItem } from '@/lib/manga.types';
import { MAX_KEYWORD_LENGTH } from '@/lib/manga-search-params';
import {
  buildSourceBuckets,
  getMangaCreators,
  groupResultsBySource,
  matchesMangaCreator,
  selectVisibleResults,
} from '@/lib/manga-search-view';

function item(
  sourceId: string,
  sourceName: string,
  id: string,
  title: string
): MangaSearchItem {
  return { id, sourceId, sourceName, title, cover: '' };
}

/**
 * 模擬實際的串流形狀：慢來源先回一筆，快的大來源後來一次進很多筆。
 * 這正是「依筆數排會讓 chip 從隊尾跳到隊首」的情境。
 */
const SLOW_FIRST: MangaSearchItem[] = [
  item('s1', '喜漫漫画', 'a1', '海賊 A'),
  item('s2', '包子漫画', 'b1', 'ONE PIECE'),
  item('s2', '包子漫画', 'b2', '航海王'),
  item('s2', '包子漫画', 'b3', '海贼王'),
  item('s3', '禁漫天堂', 'c1', 'Zebra'),
];

describe('作者／上傳者解析與篩選', () => {
  it('合併 author / artist，拆常見分隔符並去重', () => {
    const manga = {
      ...item('s1', '禁漫', '1', 'T'),
      author: '尾田榮一郎，井上雄彥 / BRAVE HEART petit',
      artist: '尾田榮一郎&鳥山明、荒木飛呂彥',
    };
    expect(getMangaCreators(manga)).toEqual([
      '尾田榮一郎',
      '井上雄彥',
      'BRAVE HEART petit',
      '鳥山明',
      '荒木飛呂彥',
    ]);
  });

  it('不按空白拆英文／韓文名稱', () => {
    const manga = {
      ...item('s1', '哔咔', '1', 'T'),
      author: 'BRAVE HEART petit',
    };
    expect(getMangaCreators(manga)).toEqual(['BRAVE HEART petit']);
  });

  it.each(['N/A', 'n/a', '佚名', '未知', 'AI', '-', '無'])(
    '忽略沒有搜尋意義的上游佔位值「%s」',
    (author) => {
      expect(
        getMangaCreators({
          ...item('s1', '禁漫', '1', 'T'),
          author,
        })
      ).toEqual([]);
    }
  );

  it('多人欄位裡混入佔位值時，只留下真作者', () => {
    /* 這條走的是拆分後的 per-part 檢查；整欄都是佔位值的測試碰不到它。 */
    expect(
      getMangaCreators({
        ...item('s1', '哔咔', '1', 'T'),
        author: '尾田荣一郎，未知 / N/A & 鳥山明',
      })
    ).toEqual(['尾田荣一郎', '鳥山明']);
  });

  it('ASCII 佔位值不受瀏覽器 locale 影響', () => {
    /*
     * toLocaleLowerCase() 會採瀏覽器預設 locale；tr-TR 會把 AI 轉成 aı，
     * 無法命中 ignored 的 ai。實作應使用 locale-insensitive toLowerCase()。
     * 這個 spy 讓退化回 toLocaleLowerCase 的一行變異在任何 CI locale 都失敗。
     */
    const spy = jest
      .spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(function (this: string) {
        return String(this).replaceAll('I', 'ı').toLowerCase();
      });
    try {
      expect(
        getMangaCreators({
          ...item('s1', '禁漫', '1', 'T'),
          author: 'AI',
        })
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('作者長度與搜尋 API 共用同一個 inclusive 上限', () => {
    const atLimit = 'x'.repeat(MAX_KEYWORD_LENGTH);
    expect(
      getMangaCreators({
        ...item('s1', '禁漫', '1', 'T'),
        author: atLimit,
      })
    ).toEqual([atLimit]);
    expect(
      getMangaCreators({
        ...item('s1', '禁漫', '2', 'T'),
        author: 'x'.repeat(MAX_KEYWORD_LENGTH + 1),
      })
    ).toEqual([]);
  });

  it('creator filter 同時比對來源與 exact creator 名稱', () => {
    const results: MangaSearchItem[] = [
      { ...item('s1', '哔咔', '1', 'A'), author: 'Q同人' },
      { ...item('s1', '哔咔', '2', 'B'), author: 'Q同人，另一位' },
      { ...item('s1', '哔咔', '3', 'C'), author: 'Q同人社' },
      { ...item('s2', 'NoyAcg', '4', 'D'), author: 'Q同人' },
      { ...item('s1', '哔咔', '5', 'E'), author: 'q同人' },
    ];
    const filter = { sourceId: 's1', name: 'Q同人' };
    expect(results.filter((manga) => matchesMangaCreator(manga, filter)).map((m) => m.id))
      .toEqual(['1', '2', '5']);
    expect(
      selectVisibleResults(results, {
        sourceFilter: [],
        sortMode: 'arrival',
        creatorFilter: filter,
      }).map((manga) => manga.id)
    ).toEqual(['1', '2', '5']);
  });

  it('creator filter 與來源 filter 可以並用', () => {
    const results: MangaSearchItem[] = [
      { ...item('s1', '哔咔', '1', 'A'), author: 'Q同人' },
      { ...item('s2', 'NoyAcg', '2', 'B'), author: 'Q同人' },
    ];
    expect(
      selectVisibleResults(results, {
        sourceFilter: ['s2'],
        sortMode: 'arrival',
        creatorFilter: { sourceId: 's1', name: 'Q同人' },
      })
    ).toEqual([]);
  });
});

describe('buildSourceBuckets', () => {
  it('串流期間維持首次回應順序，不依筆數重排', () => {
    /*
     * 這是 chip 點擊被吞掉那個 bug 的防線。改成無條件依筆數排的話，
     * s2（3 筆）會跳到 s1（1 筆）前面 —— 使用者在 mousedown 與 mouseup
     * 之間遇上這次重排，click 就被派送到共同祖先而靜默消失。
     */
    const buckets = buildSourceBuckets(SLOW_FIRST, { streaming: true });
    expect(buckets.map((b) => b.sourceId)).toEqual(['s1', 's2', 's3']);
    expect(buckets.map((b) => b.count)).toEqual([1, 3, 1]);
  });

  it('串流結束後依筆數降序', () => {
    const buckets = buildSourceBuckets(SLOW_FIRST, { streaming: false });
    expect(buckets.map((b) => b.sourceId)).toEqual(['s2', 's1', 's3']);
    expect(buckets[0].count).toBe(3);
  });

  it('sourceName 缺值時退回 sourceId', () => {
    const buckets = buildSourceBuckets([item('s9', '', 'x', 'T')], {
      streaming: false,
    });
    expect(buckets[0].sourceName).toBe('s9');
  });

  it('不就地改動傳入的 results', () => {
    const input = [...SLOW_FIRST];
    const snapshot = input.map((i) => i.id);
    buildSourceBuckets(input, { streaming: false });
    expect(input.map((i) => i.id)).toEqual(snapshot);
  });
});

describe('selectVisibleResults', () => {
  it('sourceFilter 為空等於不篩選', () => {
    const out = selectVisibleResults(SLOW_FIRST, {
      sourceFilter: [],
      sortMode: 'arrival',
    });
    expect(out).toHaveLength(SLOW_FIRST.length);
  });

  it('只留被選中的來源', () => {
    const out = selectVisibleResults(SLOW_FIRST, {
      sourceFilter: ['s2'],
      sortMode: 'arrival',
    });
    expect(out.map((i) => i.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('arrival 維持到達順序', () => {
    const out = selectVisibleResults(SLOW_FIRST, {
      sourceFilter: [],
      sortMode: 'arrival',
    });
    expect(out.map((i) => i.id)).toEqual(['a1', 'b1', 'b2', 'b3', 'c1']);
  });

  it('排序時不得就地改動傳入的 results（會改到 React state）', () => {
    /*
     * 無篩選時內部的 `filtered` 就是傳入的陣列本身。少了那次複製，
     * 這裡的 input 會被排過 —— 而它在頁面上是 useState 的值，
     * React 比對不到變化，下一次 append 又基於被改過的陣列。
     */
    const input = [...SLOW_FIRST];
    const before = input.map((i) => i.id);
    selectVisibleResults(input, { sourceFilter: [], sortMode: 'title' });
    expect(input.map((i) => i.id)).toEqual(before);
    selectVisibleResults(input, { sourceFilter: [], sortMode: 'source' });
    expect(input.map((i) => i.id)).toEqual(before);
  });

  it('source 排序把同來源聚在一起，且組內維持到達順序', () => {
    const mixed = [
      item('s2', '包子漫画', 'b1', 'T1'),
      item('s1', '喜漫漫画', 'a1', 'T2'),
      item('s2', '包子漫画', 'b2', 'T3'),
    ];
    const out = selectVisibleResults(mixed, {
      sourceFilter: [],
      sortMode: 'source',
    });
    // 包子(b) 在喜漫(x) 之前是 localeCompare 的結果；重點是同來源相鄰且內部有序
    const ids = out.map((i) => i.id);
    expect(ids.indexOf('b2')).toBe(ids.indexOf('b1') + 1);
  });

  it('title 排序依標題', () => {
    const out = selectVisibleResults(
      [
        item('s1', 'A', '1', 'Zebra'),
        item('s2', 'B', '2', 'Apple'),
        item('s3', 'C', '3', 'Mango'),
      ],
      { sourceFilter: [], sortMode: 'title' }
    );
    expect(out.map((i) => i.title)).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});

describe('groupResultsBySource', () => {
  const buckets = buildSourceBuckets(SLOW_FIRST, { streaming: false });

  it('區塊順序沿用 buckets，組內沿用傳入順序', () => {
    const visible = selectVisibleResults(SLOW_FIRST, {
      sourceFilter: [],
      sortMode: 'arrival',
    });
    const groups = groupResultsBySource(visible, buckets, {
      sortMode: 'arrival',
    });
    expect(groups.map((g) => g.sourceId)).toEqual(['s2', 's1', 's3']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('sortMode=source 時改排區塊順序（否則分組後完全看不出效果）', () => {
    /*
     * 分組後每一組內部來源相同，所以「來源名稱」排序若只作用組內，
     * 畫面上不會有任何變化 —— 使用者會以為排序壞了。
     *
     * 這裡另建一組資料：SLOW_FIRST 的字典序（包子／喜漫／禁漫）剛好與
     * 筆數降序相同，證明不了「真的重排」。下面刻意讓筆數最多的來源在
     * 字典序排最後。
     */
    const divergent: MangaSearchItem[] = [
      item('d1', '包子漫画', 'a1', 'T1'), // 字典序第 1、1 筆
      item('d2', '禁漫天堂', 'b1', 'T2'), // 字典序第 3、3 筆
      item('d2', '禁漫天堂', 'b2', 'T3'),
      item('d2', '禁漫天堂', 'b3', 'T4'),
      item('d3', '喜漫漫画', 'c1', 'T5'), // 字典序第 2、1 筆
    ];
    const divergentBuckets = buildSourceBuckets(divergent, { streaming: false });
    // 筆數降序：禁漫(3) → 包子(1) → 喜漫(1)
    expect(divergentBuckets.map((b) => b.sourceId)).toEqual(['d2', 'd1', 'd3']);

    const visible = selectVisibleResults(divergent, {
      sourceFilter: [],
      sortMode: 'source',
    });
    const groups = groupResultsBySource(visible, divergentBuckets, {
      sortMode: 'source',
    });
    // 名稱升序：包子 → 喜漫 → 禁漫，與筆數降序完全不同
    expect(groups.map((g) => g.sourceId)).toEqual(['d1', 'd3', 'd2']);
    const names = groups.map((g) => g.sourceName);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    );
  });

  it('不就地改動傳入的 buckets（chip 也在用同一個陣列）', () => {
    const before = buckets.map((b) => b.sourceId);
    const visible = selectVisibleResults(SLOW_FIRST, {
      sourceFilter: [],
      sortMode: 'source',
    });
    groupResultsBySource(visible, buckets, { sortMode: 'source' });
    expect(buckets.map((b) => b.sourceId)).toEqual(before);
  });

  it('篩選後只留有結果的區塊', () => {
    const visible = selectVisibleResults(SLOW_FIRST, {
      sourceFilter: ['s2'],
      sortMode: 'arrival',
    });
    const groups = groupResultsBySource(visible, buckets, {
      sortMode: 'arrival',
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].sourceId).toBe('s2');
    expect(groups[0].items).toHaveLength(3);
  });

  it('空結果回空陣列', () => {
    expect(groupResultsBySource([], buckets, { sortMode: 'arrival' })).toEqual(
      []
    );
  });
});
