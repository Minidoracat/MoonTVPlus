import { ArrowLeft, Disc3, Heart, ListMusic, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/cn';
import type { MusicSource } from '@/lib/music/types';
import { useOverlayFocus } from '@/hooks/useOverlayFocus';

import {
  MUSIC_DRAWER,
  MUSIC_DRAWER_BRAND,
  MUSIC_DRAWER_ITEM,
  MUSIC_DRAWER_ITEM_ACTIVE,
  MUSIC_DRAWER_ITEM_IDLE,
  MUSIC_DRAWER_LABEL,
  MUSIC_DRAWER_MARK,
  MUSIC_DRAWER_SCRIM,
  MUSIC_DRAWER_SUB,
  MUSIC_DRAWER_TITLE,
  MUSIC_ICON_BUTTON,
  MUSIC_SIDEBAR_DOCKED,
} from './tokens';

interface MusicSidebarDrawerProps {
  currentSource: MusicSource;
  isOpen: boolean;
  pathname: string | null;
  onClose: () => void;
  /** overlay：手机上的抽屉（模态）；docked：桌面常驻侧栏（没有遮罩、不抢焦点）。 */
  variant?: 'overlay' | 'docked';
}

const musicNavItems = [
  { key: 'rankings', label: '排行榜', href: '/music/rankings', Icon: ListMusic },
  { key: 'songlists', label: '推荐歌单', href: '/music/songlists', Icon: Disc3 },
  { key: 'search', label: '搜索', href: '/music/search', Icon: Search },
  { key: 'my-playlists', label: '我的歌单', href: '/music/my-playlists', Icon: Heart },
];

/**
 * 侧栏。材质跟浏览页一样（牛皮纸/烧棕 + 焦糖 + 方角），选中态只用主题色那一点，
 * 不再用渐变和光晕——那两层在日间主题下会糊成一块发绿的雾。
 *
 * 同一份导览两种摆法：手机是盖住页面的抽屉，点了就收；桌面可以常驻在左边，
 * 点导览不收起，右上角的钮是「收起侧栏」。
 */
export default function MusicSidebarDrawer({
  currentSource,
  isOpen,
  pathname,
  onClose,
  variant = 'overlay',
}: MusicSidebarDrawerProps) {
  const panelRef = useRef<HTMLElement>(null);
  const modal = variant === 'overlay';
  useOverlayFocus(isOpen && modal, panelRef);

  useEffect(() => {
    if (!isOpen || !modal) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, modal, onClose]);

  if (!isOpen) return null;

  // 只有抽屉点了导览要收起；常驻侧栏留在原地
  const onNavigate = modal ? onClose : undefined;

  const panel = (
    <>
      <div className='mb-8 flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-3'>
          <div className={MUSIC_DRAWER_BRAND}>
            <Disc3 className='h-5 w-5' strokeWidth={1.8} aria-hidden />
          </div>
          <div className='min-w-0'>
            <div className={MUSIC_DRAWER_TITLE}>音乐菜单</div>
            <div className={MUSIC_DRAWER_SUB}>Music · Reverse Side</div>
          </div>
        </div>
        <button
          type='button'
          onClick={onClose}
          className={MUSIC_ICON_BUTTON}
          aria-label={modal ? '关闭' : '收起侧栏'}
          title={modal ? undefined : '收起侧栏'}
        >
          <X className='h-4 w-4' strokeWidth={2} aria-hidden />
        </button>
      </div>

      <nav className='flex flex-col gap-1'>
        {musicNavItems.map((item) => {
          // 搜索要把当前音源一起带上，其余直接走自己的 href。
          // 别拿「没 href 就兜去排行榜」当兜底——那会把漏填的 href 变成一次
          // 静默的错跳：点"我的歌单"跳到排行榜，人在排行榜页上时就像点了没反应。
          const href = item.key === 'search' ? `${item.href}?source=${currentSource}` : item.href;
          const active = item.key === 'rankings'
            ? pathname?.startsWith('/music/rankings') || pathname === '/music'
            : pathname?.startsWith(`/music/${item.key}`);

          return (
            // 用真连结：中键／Cmd 点开新分页、长按复制网址都能用
            <Link
              key={item.key}
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                MUSIC_DRAWER_ITEM,
                active ? MUSIC_DRAWER_ITEM_ACTIVE : MUSIC_DRAWER_ITEM_IDLE
              )}
            >
              <item.Icon className='h-4 w-4 shrink-0' strokeWidth={1.9} aria-hidden />
              <span className={MUSIC_DRAWER_LABEL}>{item.label}</span>
              {active ? <span aria-hidden className={MUSIC_DRAWER_MARK} /> : null}
            </Link>
          );
        })}
      </nav>

      <div className='mt-auto border-t border-music-edge pt-4 dark:border-music-night-edge'>
        <Link
          href='/'
          onClick={onNavigate}
          className={cn(MUSIC_DRAWER_ITEM, MUSIC_DRAWER_ITEM_IDLE)}
        >
          <ArrowLeft className='h-4 w-4 shrink-0' strokeWidth={1.9} aria-hidden />
          <span className={MUSIC_DRAWER_LABEL}>返回主页</span>
        </Link>
      </div>
    </>
  );

  if (!modal) {
    return (
      <aside ref={panelRef} className={MUSIC_SIDEBAR_DOCKED} aria-label='音乐菜单'>
        {panel}
      </aside>
    );
  }

  return (
    <div className='fixed inset-0 z-[10000]'>
      <button className={MUSIC_DRAWER_SCRIM} onClick={onClose} aria-label='关闭菜单' tabIndex={-1} />
      <aside
        ref={panelRef}
        className={MUSIC_DRAWER}
        role='dialog'
        aria-modal='true'
        aria-label='音乐菜单'
      >
        {panel}
      </aside>
    </div>
  );
}
