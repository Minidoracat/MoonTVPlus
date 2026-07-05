import { shouldBlockSuspiciousAutoNext } from '@/lib/playback-auto-next';

describe('shouldBlockSuspiciousAutoNext', () => {
  it('blocks short ad-like ended events', () => {
    expect(shouldBlockSuspiciousAutoNext(35, 35)).toBe(true);
  });

  it('blocks long videos ending far before the real end', () => {
    expect(shouldBlockSuspiciousAutoNext(35, 22 * 60 + 38)).toBe(true);
  });

  it('allows normal endings near the end', () => {
    expect(shouldBlockSuspiciousAutoNext(22 * 60 + 20, 22 * 60 + 38)).toBe(
      false
    );
  });
});
