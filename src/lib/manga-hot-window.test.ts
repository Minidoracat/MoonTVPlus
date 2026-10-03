import type { MangaSourceFilterOption } from './manga.types';
import {
  findMangaHotWindows,
  matchMangaHotWindow,
} from './manga-hot-window';

// 下列 filter 都取自實際來源的 getSourceFilters 結果（position 隨意但不重複）
describe('findMangaHotWindows', () => {
  it('漫画柜：排序下拉裡的日／周／月排行', () => {
    const filters: MangaSourceFilterOption[] = [
      {
        position: 2,
        kind: 'select',
        name: '排序方式',
        values: ['人气最旺', '最新发布', '最新更新', '评分最高', '日排行', '周排行', '月排行', '总排行'],
      },
    ];
    expect(findMangaHotWindows(filters)).toEqual({
      day: [{ position: 2, kind: 'select', index: 4 }],
      week: [{ position: 2, kind: 'select', index: 5 }],
      month: [{ position: 2, kind: 'select', index: 6 }],
    });
  });

  it('禁漫天堂：只有時間的下拉要配上熱門排序', () => {
    const filters: MangaSourceFilterOption[] = [
      { position: 0, kind: 'select', name: '排序', values: ['最新', '最多浏览', '最多爱心', '最多图片'] },
      { position: 1, kind: 'select', name: '时间', values: ['全部', '今天', '这周', '本月'] },
    ];
    const sort = { position: 0, kind: 'select', index: 1 };
    expect(findMangaHotWindows(filters)).toEqual({
      day: [{ position: 1, kind: 'select', index: 1 }, sort],
      week: [{ position: 1, kind: 'select', index: 2 }, sort],
      month: [{ position: 1, kind: 'select', index: 3 }, sort],
    });
  });

  it('哔咔漫画：榜單標籤自帶「热门」就不配排序', () => {
    const filters: MangaSourceFilterOption[] = [
      { position: 0, kind: 'select', name: '排序', values: ['新到旧', '旧到新', '最多爱心', '最多绅士指名'] },
      {
        position: 1,
        kind: 'select',
        name: '榜单',
        values: ['无', '过去24小时最热门', '过去7天最热门', '过去30天最热门'],
      },
    ];
    expect(findMangaHotWindows(filters)).toEqual({
      day: [{ position: 1, kind: 'select', index: 1 }],
      week: [{ position: 1, kind: 'select', index: 2 }],
      month: [{ position: 1, kind: 'select', index: 3 }],
    });
  });

  it('嗶哩漫畫：點擊榜算時間窗，「三日內／七日內」更新時間不算', () => {
    const filters: MangaSourceFilterOption[] = [
      {
        position: 0,
        kind: 'select',
        name: '排序方式',
        values: ['最近更新', '月點擊', '周點擊', '月推薦', '周推薦', '月鮮花', '周鮮花', '字數', '收藏數', '最新入庫'],
      },
      { position: 1, kind: 'select', name: '更新時間', values: ['不限', '三日內', '七日內', '半月內', '一月內'] },
    ];
    expect(findMangaHotWindows(filters)).toEqual({
      week: [{ position: 0, kind: 'select', index: 2 }],
      month: [{ position: 0, kind: 'select', index: 1 }],
    });
  });

  it('再漫画：群組內的榜單下拉', () => {
    const filters: MangaSourceFilterOption[] = [
      {
        position: 1,
        kind: 'group_select',
        innerPosition: 0,
        name: '榜单',
        values: ['不查看榜单', '日排行', '周排行', '月排行', '总排行'],
      },
      { position: 1, kind: 'group_select', innerPosition: 1, name: '排序', values: ['人气', '吐槽', '订阅'] },
    ];
    expect(findMangaHotWindows(filters).day).toEqual([
      { position: 1, kind: 'group_select', innerPosition: 0, index: 1 },
    ]);
  });

  it('群組內只有時間的下拉先配同群組的熱門排序', () => {
    const filters: MangaSourceFilterOption[] = [
      { position: 0, kind: 'select', name: '排行', values: ['总排行'] },
      { position: 3, kind: 'group_select', innerPosition: 0, name: '时间', values: ['不限', '今日'] },
      { position: 3, kind: 'group_select', innerPosition: 1, name: '排序', values: ['最新', '人气'] },
    ];
    expect(findMangaHotWindows(filters).day).toEqual([
      { position: 3, kind: 'group_select', innerPosition: 0, index: 1 },
      { position: 3, kind: 'group_select', innerPosition: 1, index: 1 },
    ]);
  });

  it('Hanime1.me：sort 型的熱門排序', () => {
    const filters: MangaSourceFilterOption[] = [
      { position: 0, kind: 'sort', name: 'Sort', values: ['最新', '熱門：本日', '熱門：本週', '熱門：所有'] },
    ];
    expect(findMangaHotWindows(filters)).toEqual({
      day: [{ position: 0, kind: 'sort', index: 1, ascending: false }],
      week: [{ position: 0, kind: 'sort', index: 2, ascending: false }],
    });
  });

  it('只有狀態／分類的來源沒有時間窗', () => {
    const filters: MangaSourceFilterOption[] = [
      { position: 0, kind: 'select', name: '状态', values: ['全部', '连载', '完结'] },
      { position: 1, kind: 'select', name: '分类', values: ['全部', '热血', '冒险', '日常'] },
    ];
    expect(findMangaHotWindows(filters)).toEqual({});
  });
});

describe('matchMangaHotWindow', () => {
  const windows = findMangaHotWindows([
    { position: 0, kind: 'select', name: '排序', values: ['最新', '最多浏览'] },
    { position: 1, kind: 'select', name: '时间', values: ['全部', '今天', '这周', '本月'] },
    { position: 2, kind: 'select', name: '分类', values: ['全部', '同人'] },
  ]);

  it('與選擇順序無關', () => {
    expect(
      matchMangaHotWindow(windows, [
        { position: 0, kind: 'select', index: 1 },
        { position: 1, kind: 'select', index: 2 },
      ])
    ).toBe('week');
  });

  it('多一個無關的選擇就不算時間窗', () => {
    expect(
      matchMangaHotWindow(windows, [
        { position: 1, kind: 'select', index: 2 },
        { position: 0, kind: 'select', index: 1 },
        { position: 2, kind: 'select', index: 1 },
      ])
    ).toBeNull();
  });

  it('只套了時間、沒配排序也不算', () => {
    expect(
      matchMangaHotWindow(windows, [{ position: 1, kind: 'select', index: 2 }])
    ).toBeNull();
  });
});
