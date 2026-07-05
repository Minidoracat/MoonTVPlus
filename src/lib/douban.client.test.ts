import { getDoubanDetail } from '@/lib/douban.client';

describe('getDoubanDetail', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('doubanDataSource', 'direct');
    localStorage.setItem('doubanDataSourceBackup', 'direct');
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('can suppress the global error toast when caller will fall back', async () => {
    const listener = jest.fn();
    window.addEventListener('globalError', listener);

    await expect(
      getDoubanDetail('1292052', { suppressGlobalError: true })
    ).rejects.toThrow('HTTP error');

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('globalError', listener);
  });
});
