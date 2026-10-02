/**
 * 開章節的即時回饋，外觀對齊閱讀器自己的單頁骨架，頁面接手時不會跳。
 * 理由同 detail/loading.tsx：boundary 要放在被導覽到的這一段才會被預取。
 */
import MangaLoadingStatus from '@/components/manga/MangaLoadingStatus';

export default function MangaReadLoading() {
  return (
    <div aria-busy='true'>
      <MangaLoadingStatus label='正在打开章节' />
      <div className='min-h-[calc(100vh-8rem)] bg-gray-100 motion-safe:animate-pulse dark:bg-gray-900' />
    </div>
  );
}
