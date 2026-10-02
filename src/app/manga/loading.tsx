/**
 * 從站內其他區塊（首頁、底部導覽）進入 /manga 時的即時回饋。沒有 boundary 時，點下去畫面會停在
 * 上一頁、只剩頂端一條細進度條，直到伺服器回應，看起來像點了沒反應。
 * 只管進入 manga 這一段；detail、read 各有自己的 loading.tsx（原因見 detail/loading.tsx）。
 */
export default function MangaLoading() {
  return (
    <div className='mx-auto max-w-6xl space-y-4' aria-busy='true'>
      <p role='status' className='sr-only'>
        载入中
      </p>
      <div className='h-28 rounded-3xl bg-gray-200/70 motion-safe:animate-pulse dark:bg-gray-800/70' />
      <div className='h-6 w-40 rounded-full bg-gray-200/70 motion-safe:animate-pulse dark:bg-gray-800/70' />
      <div className='h-64 rounded-3xl bg-gray-200/70 motion-safe:animate-pulse dark:bg-gray-800/70' />
    </div>
  );
}
