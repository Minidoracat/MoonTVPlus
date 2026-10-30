import { cookies } from 'next/headers';

import { parseAuthInfo } from '@/lib/auth';
import type { MangaAdultView } from '@/lib/manga.types';
import { getMangaAdultView } from '@/lib/permissions';

import MangaLayout from '@/components/manga/MangaLayout';

export default async function MangaAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 頂欄的盾牌與詳情／閱讀頁標題要在伺服器渲染時就定好：等掛載後才讀，
  // 安全模式下網址裡的書名會先進 HTML。localstorage 模式沒有地方存安全模式，不給盾牌。
  const adultView: MangaAdultView =
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
      ? 'none'
      : await getMangaAdultView(parseAuthInfo(cookies().get('auth')?.value)?.username);
  return <MangaLayout adultView={adultView}>{children}</MangaLayout>;
}
