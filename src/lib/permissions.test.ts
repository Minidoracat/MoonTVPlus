/**
 * @jest-environment node
 */

/**
 * 成人漫畫源的檢視狀態。預設要看不到：沒有欄位的舊使用者、被封禁、DB 故障一律 none，
 * 只有站長與被管理員逐一開放的人是 shown，開了安全模式的是 hidden。
 */
jest.mock('@/lib/db', () => ({
  db: { getUserInfoV2: jest.fn() },
}));
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
}));
// permissions.ts 頂層 import next/server；jest 的 node 環境沒有 Request，這裡只需要 NextResponse
jest.mock('next/server', () => ({ NextResponse: { json: jest.fn() } }));

import { db } from '@/lib/db';
import { getMangaAdultView } from '@/lib/permissions';

const getUserInfoV2 = db.getUserInfoV2 as jest.Mock;

describe('getMangaAdultView', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USERNAME = 'owner';
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('站長沒有開放欄位也看得到', async () => {
    getUserInfoV2.mockResolvedValue({ role: 'owner', banned: false });
    expect(await getMangaAdultView('owner')).toBe('shown');
  });

  it('站長開了安全模式 → hidden', async () => {
    getUserInfoV2.mockResolvedValue({
      role: 'owner',
      banned: false,
      mangaSafeMode: true,
    });
    expect(await getMangaAdultView('owner')).toBe('hidden');
  });

  it('沒有 mangaAdult 欄位的使用者 → none（含管理員）', async () => {
    getUserInfoV2.mockResolvedValue({ role: 'admin', banned: false });
    expect(await getMangaAdultView('bob')).toBe('none');
  });

  it('沒開放卻帶著安全模式欄位 → 仍是 none', async () => {
    getUserInfoV2.mockResolvedValue({
      role: 'user',
      banned: false,
      mangaSafeMode: true,
    });
    expect(await getMangaAdultView('alice')).toBe('none');
  });

  it('已開放 → shown', async () => {
    getUserInfoV2.mockResolvedValue({
      role: 'user',
      banned: false,
      mangaAdult: true,
    });
    expect(await getMangaAdultView('alice')).toBe('shown');
  });

  it('已開放且開了安全模式 → hidden', async () => {
    getUserInfoV2.mockResolvedValue({
      role: 'user',
      banned: false,
      mangaAdult: true,
      mangaSafeMode: true,
    });
    expect(await getMangaAdultView('alice')).toBe('hidden');
  });

  it('被封禁 → none', async () => {
    getUserInfoV2.mockResolvedValue({
      role: 'user',
      banned: true,
      mangaAdult: true,
    });
    expect(await getMangaAdultView('alice')).toBe('none');
  });

  it('使用者不存在或沒有使用者名稱 → none', async () => {
    getUserInfoV2.mockResolvedValue(null);
    expect(await getMangaAdultView('ghost')).toBe('none');
    expect(await getMangaAdultView(undefined)).toBe('none');
  });

  it('DB 故障 → none（寧可藏起來也不露出）', async () => {
    getUserInfoV2.mockRejectedValue(new Error('db down'));
    expect(await getMangaAdultView('alice')).toBe('none');
  });
});
