import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { loadTraditionalToSimplifiedConverter } from '@/lib/danmaku/traditional-to-simplified';

import SearchPage from './page';

const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/danmaku/traditional-to-simplified', () => ({
  loadTraditionalToSimplifiedConverter: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  getAuthInfoFromBrowserCookie: jest.fn(() => null),
}));

jest.mock('@/lib/db.client', () => ({
  addSearchHistory: jest.fn(),
  clearSearchHistory: jest.fn(),
  deleteSearchHistory: jest.fn(),
  getSearchHistory: jest.fn(() => Promise.resolve([])),
  subscribeToDataUpdates: jest.fn(() => jest.fn()),
}));

jest.mock('@/lib/special-source.client', () => ({
  appendSpecialSourceParam: (url: string) => url,
  isSpecialSourcesEnabledOnDevice: jest.fn(() => false),
}));

jest.mock('@/components/PageLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const react = require('react');
    return react.createElement('main', null, children);
  },
}));

jest.mock('@/components/Toast', () => ({
  __esModule: true,
  default: ({ message }: { message: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const react = require('react');
    return react.createElement('div', { role: 'alert' }, message);
  },
}));

// 以下子元件在本檔案只需要「不渲染」，共用同一份 null 模組
function mockNullComponent() {
  return { __esModule: true, default: () => null };
}

jest.mock('@/components/AcgSearch', mockNullComponent);
jest.mock('@/components/CapsuleSwitch', mockNullComponent);
jest.mock('@/components/DetailPanel', mockNullComponent);
jest.mock('@/components/ImageViewer', mockNullComponent);
jest.mock('@/components/ProxyImage', mockNullComponent);
jest.mock('@/components/SearchResultFilter', mockNullComponent);
jest.mock('@/components/SearchSuggestions', mockNullComponent);
jest.mock('@/components/VideoCard', mockNullComponent);
jest.mock('@/components/VirtualScrollableGrid', mockNullComponent);
jest.mock('@/components/PansouSearch', () => ({
  __esModule: true,
  CLOUD_TYPE_NAMES: {},
  default: () => null,
}));

const mockedLoadConverter = jest.mocked(loadTraditionalToSimplifiedConverter);
const mockFetch = jest.fn();
const mutableGlobal = global as unknown as {
  fetch?: jest.Mock;
  requestAnimationFrame?: jest.Mock;
};

type RuntimeWindow = Window & {
  RUNTIME_CONFIG?: Record<string, boolean>;
};

function submittedQuery(callIndex = 0): string | null {
  const href = mockRouter.push.mock.calls[callIndex]?.[0];
  return href ? new URL(href, 'http://localhost').searchParams.get('q') : null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
  mockedLoadConverter.mockReset();
  mockFetch.mockReset().mockResolvedValue({
    json: () => Promise.resolve({ results: [] }),
  });
  mutableGlobal.fetch = mockFetch;
  mutableGlobal.requestAnimationFrame = jest.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem('fluidSearch', 'false');
  (window as RuntimeWindow).RUNTIME_CONFIG = {};
});

afterEach(() => {
  cleanup();
  delete mutableGlobal.fetch;
  delete mutableGlobal.requestAnimationFrame;
  delete (window as RuntimeWindow).RUNTIME_CONFIG;
});

describe('搜尋 OpenCC 按需載入', () => {
  it('功能關閉時不載入 OpenCC，URL query 仍會自動搜尋', async () => {
    mockSearchParams = new URLSearchParams({ q: '繁體查詢', type: 'video' });

    render(<SearchPage />);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`q=${encodeURIComponent('繁體查詢')}`)
      )
    );
    expect(mockedLoadConverter).not.toHaveBeenCalled();
  });

  it('功能開啟後第一次提交會等待 converter 再使用轉換結果', async () => {
    const { promise, resolve } = deferred<((text: string) => string) | null>();
    mockedLoadConverter.mockReturnValue(promise);
    window.localStorage.setItem('searchTraditionalToSimplified', 'true');
    render(<SearchPage />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '繁體查詢' } });
    fireEvent.submit(input.closest('form')!);

    expect(mockedLoadConverter).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();

    await act(async () => {
      resolve((text) => text.replace('繁體', '简体'));
      await Promise.resolve();
    });

    await waitFor(() => expect(submittedQuery()).toBe('简体查詢'));
  });

  it('轉換未完成時輸入改變不提交或覆寫新查詢', async () => {
    const { promise, resolve } = deferred<(text: string) => string>();
    mockedLoadConverter.mockReturnValue(promise);
    window.localStorage.setItem('searchTraditionalToSimplified', 'true');
    render(<SearchPage />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '舊查詢' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.change(input, { target: { value: '新查詢' } });

    await act(async () => {
      resolve((text) => `已轉換:${text}`);
      await Promise.resolve();
    });

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(input).toHaveValue('新查詢');
  });

  it('轉換未完成時清除輸入不會提交舊查詢', async () => {
    const { promise, resolve } = deferred<(text: string) => string>();
    mockedLoadConverter.mockReturnValue(promise);
    window.localStorage.setItem('searchTraditionalToSimplified', 'true');
    render(<SearchPage />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '舊查詢' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: '清除搜索内容' }));

    await act(async () => {
      resolve((text) => `已轉換:${text}`);
      await Promise.resolve();
    });

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('searchParams 導航會取消尚未完成的手動搜尋', async () => {
    const { promise, resolve } = deferred<(text: string) => string>();
    mockedLoadConverter.mockReturnValue(promise);
    window.localStorage.setItem('searchTraditionalToSimplified', 'true');
    const { rerender } = render(<SearchPage />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '待取消查詢' } });
    fireEvent.submit(input.closest('form')!);

    window.localStorage.setItem('searchTraditionalToSimplified', 'false');
    mockSearchParams = new URLSearchParams({ q: '返回查詢' });
    rerender(<SearchPage />);

    await act(async () => {
      resolve((text) => `已轉換:${text}`);
      await Promise.resolve();
    });

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(input).not.toHaveValue('已轉換:待取消查詢');
  });

  it('loader 回傳 null 時提示並用原查詢，下一次操作會重新載入', async () => {
    mockedLoadConverter
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce((text) => `已轉換:${text}`);
    window.localStorage.setItem('searchTraditionalToSimplified', 'true');
    render(<SearchPage />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '第一次' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(submittedQuery()).toBe('第一次'));
    expect(screen.getByRole('alert')).toHaveTextContent(
      '繁簡轉換載入失敗，已使用原關鍵字搜尋，請稍後重試。'
    );

    fireEvent.change(input, { target: { value: '第二次' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(mockedLoadConverter).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(submittedQuery(1)).toBe('已轉換:第二次'));
  });
});
