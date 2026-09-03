import type { MangaShelfItem } from '@/lib/manga.types';
import {
  type ShelfTab,
  selectShelfEntries,
  shelfSubtitle,
} from '@/lib/manga-shelf';

function item(
  key: string,
  overrides: Partial<MangaShelfItem> = {}
): MangaShelfItem {
  return {
    title: key,
    cover: '',
    sourceId: 'source',
    sourceName: 'S',
    mangaId: key,
    saveTime: 0,
    ...overrides,
  };
}

function shelf(
  ...items: [string, Partial<MangaShelfItem>][]
): Record<string, MangaShelfItem> {
  return Object.fromEntries(
    items.map(([key, overrides]) => [key, item(key, overrides)])
  );
}

const keysOf = (shelfMap: Record<string, MangaShelfItem>, tab: ShelfTab) =>
  selectShelfEntries(shelfMap, tab).map(([key]) => key);

describe('selectShelfEntries 排序', () => {
  it('未读置顶并按 updateTime 排序，其余按 updateTime ?? saveTime 排序', () => {
    const data = shelf(
      ['save-old', { saveTime: 10 }],
      ['unread-none', { unreadChapterCount: 3, saveTime: 999 }],
      ['unread-old', { unreadChapterCount: 1, updateTime: 100 }],
      ['update-wins', { updateTime: 700, saveTime: 1 }],
      ['zero-unread', { unreadChapterCount: 0, saveTime: 400 }],
      ['save-new', { saveTime: 500 }],
      ['unread-new', { unreadChapterCount: 2, updateTime: 500 }]
    );
    expect(keysOf(data, 'all')).toEqual([
      'unread-new',
      'unread-old',
      'unread-none',
      'update-wins',
      'save-new',
      'zero-unread',
      'save-old',
    ]);
  });
});

describe('selectShelfEntries 筛选', () => {
  it('favorite 只留 favorite === true', () => {
    const data = shelf(
      ['fav', { favorite: true }],
      ['not-fav', { favorite: false }],
      ['unset', {}]
    );
    expect(keysOf(data, 'favorite')).toEqual(['fav']);
  });

  it('正确区分未完结与已完结状态', () => {
    const data = shelf(
      ['ongoing-zh-cn', { status: '未完结' }],
      ['ongoing-zh-tw', { status: '未完結' }],
      ['ongoing-en', { status: 'UNFINISHED' }],
      ['ongoing-anilist', { status: 'NOT_COMPLETED' }],
      ['completed-zh-cn', { status: '已完结' }],
      ['completed-en', { status: 'COMPLETED' }],
      ['completed-anilist', { status: 'PUBLISHING_FINISHED' }]
    );
    expect(keysOf(data, 'ongoing').sort()).toEqual([
      'ongoing-anilist',
      'ongoing-en',
      'ongoing-zh-cn',
      'ongoing-zh-tw',
    ]);
    expect(keysOf(data, 'completed').sort()).toEqual([
      'completed-anilist',
      'completed-en',
      'completed-zh-cn',
    ]);
  });
});

describe('shelfSubtitle', () => {
  it('显示双边、单边章节或 fallback author', () => {
    expect(
      shelfSubtitle(
        item('k', { lastChapterName: '第 3 话', latestChapterName: '第 9 话' })
      )
    ).toBe('已读 第 3 话 / 最新 第 9 话');
    expect(shelfSubtitle(item('k', { lastChapterName: '第 3 话' }))).toBe(
      '已读 第 3 话'
    );
    expect(shelfSubtitle(item('k', { latestChapterName: '第 9 话' }))).toBe(
      '最新 第 9 话'
    );
    expect(shelfSubtitle(item('k', { author: '尾田' }))).toBe('尾田');
  });
});
