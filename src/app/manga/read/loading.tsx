/**
 * 開章節的即時回饋，外觀對齊閱讀器自己的單頁骨架，頁面接手時不會跳。
 * 理由同 detail/loading.tsx：boundary 要放在被導覽到的這一段才會被預取。
 */
export default function MangaReadLoading() {
  return (
    <div
      aria-busy='true'
      className='min-h-[calc(100vh-8rem)] bg-gray-100 motion-safe:animate-pulse dark:bg-gray-900'
    >
      <p role='status' className='sr-only'>
        正在打开章节
      </p>
    </div>
  );
}
