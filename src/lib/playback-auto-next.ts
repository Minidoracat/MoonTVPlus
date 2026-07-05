const MIN_AUTO_NEXT_WATCH_SECONDS = 90;
const LONG_VIDEO_SECONDS = 300;
const NEAR_END_SECONDS = 30;

export function shouldBlockSuspiciousAutoNext(
  currentTime: number,
  duration: number
): boolean {
  const watched = Number.isFinite(currentTime) ? currentTime : 0;
  const total = Number.isFinite(duration) ? duration : 0;

  // ponytail: simple heuristic; switch to per-source manifest checks if short clips need auto-next.
  return (
    watched < MIN_AUTO_NEXT_WATCH_SECONDS ||
    (total >= LONG_VIDEO_SECONDS && watched < total - NEAR_END_SECONDS)
  );
}
