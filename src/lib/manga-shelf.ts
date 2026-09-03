import type { MangaShelfItem } from '@/lib/manga.types';

export type ShelfTab = 'all' | 'favorite' | 'ongoing' | 'completed';

export const SHELF_TABS: { key: ShelfTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'favorite', label: '最爱' },
  { key: 'ongoing', label: '连载中' },
  { key: 'completed', label: '已完结' },
];

const isCompleted = (item: MangaShelfItem) => {
  const status = (item.status ?? '').trim().toUpperCase();
  // 否定前缀优先：未完结 / UNFINISHED / NOT_COMPLETED 都是连载中。
  if (/^(NOT_|UN)/.test(status) || status.includes('未完')) return false;
  return /完结|完結|COMPLETED|FINISHED/.test(status);
};

/** 永远显示「已读 / 最新」进度；未读数量由封面 badge 呈现。 */
export function shelfSubtitle(item: MangaShelfItem): string | undefined {
  const read = item.lastChapterName ? `已读 ${item.lastChapterName}` : '';
  const latest = item.latestChapterName ? `最新 ${item.latestChapterName}` : '';
  if (read && latest) return `${read} / ${latest}`;
  return read || latest || item.author || item.status || undefined;
}

/** 依分页筛选书架，并把有未读更新的固定置顶；其内按更新时间新→旧，其余按 updateTime ?? saveTime。 */
export function selectShelfEntries(
  shelf: Record<string, MangaShelfItem>,
  tab: ShelfTab
): [string, MangaShelfItem][] {
  const entries = Object.entries(shelf).filter(([, item]) => {
    if (tab === 'favorite') return item.favorite === true;
    if (tab === 'completed') return isCompleted(item);
    if (tab === 'ongoing') return !isCompleted(item);
    return true;
  });
  return entries.sort(([, a], [, b]) => {
    const aUnread = (a.unreadChapterCount ?? 0) > 0;
    const bUnread = (b.unreadChapterCount ?? 0) > 0;
    if (aUnread !== bUnread) return aUnread ? -1 : 1;
    if (aUnread) return (b.updateTime ?? 0) - (a.updateTime ?? 0);
    return (b.updateTime ?? b.saveTime) - (a.updateTime ?? a.saveTime);
  });
}
