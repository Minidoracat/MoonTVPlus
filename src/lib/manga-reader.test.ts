import {
  buildMangaAlternateSearchHref,
  buildMangaReadHref,
  buildMangaShelfItem,
  getHorizontalPageIndex,
  getHorizontalPageOffset,
  getHorizontalPageStride,
  getNextMangaChapter,
  getReaderProgress,
  getReaderStartPage,
  isVerticalRestoreWindowSettled,
  orderMangaChapters,
  shouldEagerLoadVerticalRestorePage,
} from '@/lib/manga-reader';
import type {
  MangaChapter,
  MangaDetail,
  MangaReadRecord,
} from '@/lib/manga.types';

function chapter(
  id: string,
  chapterNumber: number,
  uploadDate = 0
): MangaChapter {
  return { id, mangaId: 'manga', name: id, chapterNumber, uploadDate };
}

function record(chapterId: string, pageIndex: number): MangaReadRecord {
  return {
    title: 'T',
    sourceId: 'source',
    mangaId: 'manga',
    cover: '',
    sourceName: 'S',
    chapterId,
    chapterName: chapterId,
    pageIndex,
    pageCount: 10,
    saveTime: 1,
  };
}

describe('reader chapter navigation', () => {
  it('章節列表與下一話共用 chapterNumber → uploadDate → id 排序', () => {
    const input = [
      chapter('a-late', 2, 20),
      chapter('c1', 1, 30),
      chapter('z-early', 2, 10),
      chapter('b-late', 2, 20),
    ];
    expect(orderMangaChapters(input).map((item) => item.id)).toEqual([
      'c1',
      'z-early',
      'a-late',
      'b-late',
    ]);
    // 不得就地改動 GraphQL/state 的 chapters
    expect(input.map((item) => item.id)).toEqual([
      'a-late',
      'c1',
      'z-early',
      'b-late',
    ]);
  });

  it('取得下一話；最後一話與未知章節回 null', () => {
    const chapters = [chapter('c3', 3), chapter('c1', 1), chapter('c2', 2)];
    expect(getNextMangaChapter(chapters, 'c1')?.id).toBe('c2');
    expect(getNextMangaChapter(chapters, 'c2')?.id).toBe('c3');
    expect(getNextMangaChapter(chapters, 'c3')).toBeNull();
    expect(getNextMangaChapter(chapters, 'missing')).toBeNull();
  });
});

describe('reader start page', () => {
  it('章節列表／下一話明確要求第一頁時，歷史紀錄不能覆蓋', () => {
    expect(
      getReaderStartPage({
        forceFirstPage: true,
        record: record('c2', 9),
        chapterId: 'c2',
        pageCount: 10,
      })
    ).toBe(0);
  });

  it('一般進入同章節時續讀；紀錄會 clamp 到合法頁', () => {
    expect(
      getReaderStartPage({
        forceFirstPage: false,
        record: record('c2', 6),
        chapterId: 'c2',
        pageCount: 10,
      })
    ).toBe(6);
    expect(
      getReaderStartPage({
        forceFirstPage: false,
        record: record('c2', 99),
        chapterId: 'c2',
        pageCount: 10,
      })
    ).toBe(9);
  });

  it('紀錄屬於另一話或不存在時從第一頁開始', () => {
    expect(
      getReaderStartPage({
        forceFirstPage: false,
        record: record('c1', 8),
        chapterId: 'c2',
        pageCount: 10,
      })
    ).toBe(0);
    expect(
      getReaderStartPage({
        forceFirstPage: false,
        record: undefined,
        chapterId: 'c2',
        pageCount: 10,
      })
    ).toBe(0);
  });
});

describe('reader progress', () => {
  it('第一頁、末頁與越界頁會 clamp', () => {
    expect(getReaderProgress(0, 10)).toBe(10);
    expect(getReaderProgress(9, 10)).toBe(100);
    expect(getReaderProgress(99, 10)).toBe(100);
    expect(getReaderProgress(-5, 10)).toBe(10);
    expect(getReaderProgress(0, 0)).toBe(0);
  });
});

describe('horizontal page geometry', () => {
  it('頁面步幅包含 viewport 寬與 pageGap', () => {
    expect(getHorizontalPageStride(390, 48)).toBe(438);
    expect(getHorizontalPageOffset(20, 390, 48)).toBe(8760);
  });

  it('scrollLeft 依同一個 stride 換算頁碼並 clamp', () => {
    expect(getHorizontalPageIndex(0, 390, 48, 38)).toBe(0);
    expect(getHorizontalPageIndex(438 * 20, 390, 48, 38)).toBe(20);
    expect(getHorizontalPageIndex(999999, 390, 48, 38)).toBe(37);
    expect(getHorizontalPageIndex(100, 390, 48, 0)).toBe(0);
  });
});

describe('reader navigation href', () => {
  const base = {
    mangaId: 'manga&1',
    sourceId: 'source',
    chapterId: 'chapter',
    title: '作品 名',
    cover: '/cover?a=1',
    sourceName: '來源',
    chapterName: '第 2 話',
    returnTo: '/manga?tab=shelf',
  };

  it('明確選章帶一次性 startPage=1；繼續閱讀不帶', () => {
    const selected = new URL(
      buildMangaReadHref({ ...base, startAtFirstPage: true }),
      'http://reader.test'
    );
    expect(selected.searchParams.get('mangaId')).toBe('manga&1');
    expect(selected.searchParams.get('startPage')).toBe('1');

    const resumed = new URL(
      buildMangaReadHref({ ...base, startAtFirstPage: false }),
      'http://reader.test'
    );
    expect(resumed.searchParams.has('startPage')).toBe(false);
  });

  it('其他来源搜索使用既有 manga search URL 并编码标题', () => {
    const href = buildMangaAlternateSearchHref(' 作品 & 名 ');
    const url = new URL(href, 'http://reader.test');
    expect(url.pathname).toBe('/manga/search');
    expect(url.searchParams.get('q')).toBe('作品 & 名');
  });
});

describe('reader shelf item', () => {
  it('共用章节排序产生目前话与最新话 metadata', () => {
    const detail: MangaDetail = {
      id: 'manga',
      sourceId: 'source',
      sourceName: '来源',
      title: '作品',
      cover: '/cover',
      description: '简介',
      author: '作者',
      status: 'ONGOING',
      chapters: [
        chapter('late', 2, 20),
        chapter('first', 1, 30),
        chapter('early', 2, 10),
      ],
    };
    expect(
      buildMangaShelfItem({
        detail,
        currentChapter: { id: 'early', name: '第 2 话' },
        unreadChapterCount: 1,
        saveTime: 123,
      })
    ).toMatchObject({
      mangaId: 'manga',
      sourceId: 'source',
      saveTime: 123,
      lastChapterId: 'early',
      lastChapterName: '第 2 话',
      latestChapterId: 'late',
      latestChapterName: 'late',
      latestChapterCount: 3,
      unreadChapterCount: 1,
    });
  });
});

describe('vertical restore window', () => {
  it('只 eager 固定大小的 target 窗，不隨 target 線性成長', () => {
    const eagerPages = Array.from({ length: 120 }, (_, index) => index).filter(
      (index) => shouldEagerLoadVerticalRestorePage(index, 100, 5)
    );
    expect(eagerPages).toEqual([99, 100, 101, 102, 103, 104, 105]);
  });

  it('target 與前一頁皆 settle 後才提早解除 restore gate', () => {
    const settled = new Set([99, 100]);
    expect(isVerticalRestoreWindowSettled(settled, 100)).toBe(true);

    settled.delete(99);
    expect(isVerticalRestoreWindowSettled(settled, 100)).toBe(false);
  });
});
