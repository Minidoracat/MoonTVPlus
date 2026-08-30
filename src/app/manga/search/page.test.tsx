/**
 * 多來源批次搜尋的 observable lifecycle。
 *
 * 這一頁的退化都不會讓任何東西「壞掉」：畫面照樣畫得出卡片，只是
 *   - 三批 5/5/2 變成一次全發（伺服器上限被繞過、第一張卡片反而更慢），
 *   - 全域進度「搜索中 7/12」在每批開頭被批內計數打回 0/5，
 *   - 停止搜索留下一條還活著的 stream，或被講成紅色的連線錯誤，
 *   - 340 筆結果一次 render 340 張卡（低階手機直接卡死），
 *   - 來源清單 API 失敗時自己拆批，讓每批各吃一次 server maxSources，
 *   - 預設語言清單把明確選取的跨語言來源從 request 裡刪掉，
 *   - transport／伺服器錯誤後照樣把剩下的批次發出去。
 *
 * 所以這裡守的是「使用者看得到什麼、伺服器收到幾個 request」，
 * 不是任何內部函式的形狀：request 次序與 sourceIds、可見進度文字、
 * 停止／錯誤狀態、以及 DOM 上的卡片數量。
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import type { MangaSearchItem, MangaSource } from '@/lib/manga.types';
import { MANGA_RESULT_RENDER_PAGE_SIZE } from '@/lib/manga-search-view';

import MangaSearchPage from './page';

/* ------------------------------------------------------------------ mocks */

const mockRouter = { push: jest.fn(), replace: jest.fn() };

let mockSearchParams = new URLSearchParams();

// Jest needs writable browser globals; keep the unavoidable cast at one named boundary.
const mutableGlobal = global as unknown as {
  fetch?: jest.Mock;
  EventSource?: unknown;
};

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/db.client', () => ({
  getAllMangaShelf: jest.fn(() => Promise.resolve({})),
  saveMangaShelf: jest.fn(() => Promise.resolve()),
  deleteMangaShelf: jest.fn(() => Promise.resolve()),
}));

/**
 * 卡片替身：只留使用者看得到的標題連結，用來數「畫了幾張卡」。
 * 真的 MangaCard 會拉封面代理與圖片探測，那是另一個元件的事。
 */
jest.mock('@/components/MangaCard', () => ({
  __esModule: true,
  default: (props: { item: { title: string }; href: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const react = require('react');
    return react.createElement(
      'a',
      { 'data-testid': 'manga-card', href: props.href },
      props.item.title
    );
  },
}));

/** 來源選單有自己的 sheet／portal，與這裡要守的批次流程無關 */
jest.mock('@/components/manga/MangaSourceMultiPicker', () => ({
  __esModule: true,
  default: () => null,
}));

/* ------------------------------------------------------- fake EventSource */

type SsePayload = Record<string, unknown>;

/**
 * 可程式控制的 SSE 替身。
 *
 * 記下每一條被開出去的 stream（順序＝request 順序）與它有沒有被關掉，
 * 讓「上一批 complete 前不發下一批」與「停止要真的關連線」可被斷言。
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /** 餵一則 SSE message */
  emit(payload: SsePayload) {
    if (this.closed) {
      throw new Error(`emit after close: ${this.url}`);
    }
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** transport 層失敗：代理中斷、401、串流提前結束 */
  fail() {
    this.onerror?.(new Event('error'));
  }

  private get parsed(): URL {
    return new URL(this.url, 'http://localhost');
  }

  get path(): string {
    return this.parsed.pathname;
  }

  get keyword(): string {
    return this.parsed.searchParams.get('q') ?? '';
  }

  /** 這一個 request 實際要伺服器查的來源（空字串＝交給伺服器決定） */
  get requestedSourceIds(): string {
    return this.parsed.searchParams.get('sourceIds') ?? '';
  }
}

/* ----------------------------------------------------------------- helpers */

function streams(): FakeEventSource[] {
  return FakeEventSource.instances;
}

function mockSourcesResponse(
  response:
    | { sources: MangaSource[]; probe?: unknown; maxSources?: number }
    | 'reject'
) {
  mutableGlobal.fetch = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.startsWith('/api/manga/sources')) {
      if (response === 'reject') {
        return Promise.reject(new Error('sources unavailable'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(response),
      });
    }
    // 流式路徑不該打 REST 搜尋；打了就讓錯誤橫幅講清楚是誰
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
  });
}

function sourceList(count: number): MangaSource[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${String(index + 1).padStart(2, '0')}`,
    name: `来源 ${index + 1}`,
  }));
}

function items(sourceId: string, count: number): MangaSearchItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sourceId}-${index}`,
    sourceId,
    sourceName: `来源 ${sourceId}`,
    title: `作品 ${sourceId}-${index}`,
    cover: '',
  }));
}

function sourceResult(sourceId: string, count = 1): SsePayload {
  return {
    type: 'source_result',
    sourceId,
    elapsedMs: 120,
    results: items(sourceId, count),
  };
}

function batchComplete(attempted: number): SsePayload {
  return { type: 'complete', totalSources: attempted, failedSources: [] };
}

/** 餵事件並把 React 的更新與後續 promise 收尾都跑完 */
async function deliver(es: FakeEventSource, ...payloads: SsePayload[]) {
  await act(async () => {
    for (const payload of payloads) es.emit(payload);
    await Promise.resolve();
  });
}

async function breakTransport(es: FakeEventSource) {
  await act(async () => {
    es.fail();
    await Promise.resolve();
  });
}

/** 讓已排定的 microtask／macrotask 跑完，之後才能斷言「沒有下一批」 */
async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForStream(index: number): Promise<FakeEventSource> {
  await waitFor(() => expect(streams().length).toBeGreaterThan(index));
  return streams()[index];
}

function cardCount(): number {
  return screen.queryAllByTestId('manga-card').length;
}

/**
 * 紅色錯誤區塊。停止搜索刻意**不**走這裡（它是中性的琥珀色狀態），
 * 所以「有沒有紅色錯誤」本身就是要守的 contract。
 */
function errorBanner(container: HTMLElement): Element | null {
  return container.querySelector('.text-red-500');
}

/* ------------------------------------------------------------------- setup */

beforeEach(() => {
  FakeEventSource.instances = [];
  mockSearchParams = new URLSearchParams();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // 流式（SSE）是預設路徑，明寫以免受環境影響
  window.localStorage.setItem('fluidSearch', 'true');
  mutableGlobal.EventSource = FakeEventSource;
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
});

afterEach(() => {
  cleanup();
  delete mutableGlobal.EventSource;
  delete mutableGlobal.fetch;
});

/* -------------------------------------------------------------------- tests */

describe('MangaSearchPage 批次序列', () => {
  it('12 顆來源切成 5/5/2 依序查詢，上一批收尾前不發下一批，全域進度不歸零', async () => {
    mockSourcesResponse({ sources: sourceList(12), probe: {}, maxSources: 12 });
    mockSearchParams = new URLSearchParams({ q: '海賊' });

    const { container } = render(<MangaSearchPage />);

    const first = await waitForStream(0);
    expect(first.path).toBe('/api/manga/search/ws');
    expect(first.keyword).toBe('海賊');
    expect(first.requestedSourceIds).toBe('s01,s02,s03,s04,s05');

    // 分母來自批次計畫（12），不是批內回報的 5
    await deliver(
      first,
      { type: 'start', totalSources: 5 },
      sourceResult('s01'),
      sourceResult('s02'),
      sourceResult('s03')
    );
    await settle();
    expect(streams()).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByText('搜索中 3/12')).toBeInTheDocument()
    );

    await deliver(
      first,
      sourceResult('s04'),
      sourceResult('s05'),
      batchComplete(5)
    );
    expect(first.closed).toBe(true);

    const second = await waitForStream(1);
    expect(second.requestedSourceIds).toBe('s06,s07,s08,s09,s10');

    // 第二批開頭再報一次批內總數，全域進度不能被打回 0/5
    await deliver(
      second,
      { type: 'start', totalSources: 5 },
      sourceResult('s06')
    );
    await waitFor(() =>
      expect(screen.getByText('搜索中 6/12')).toBeInTheDocument()
    );

    await deliver(
      second,
      sourceResult('s07'),
      sourceResult('s08'),
      sourceResult('s09'),
      sourceResult('s10'),
      batchComplete(5)
    );

    const third = await waitForStream(2);
    expect(third.requestedSourceIds).toBe('s11,s12');

    await deliver(
      third,
      sourceResult('s11'),
      sourceResult('s12'),
      batchComplete(2)
    );
    await settle();

    // 剛好三個 request，沒有第四批
    expect(streams()).toHaveLength(3);
    // 每一批都 append，不是覆蓋
    await waitFor(() => expect(cardCount()).toBe(12));
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull();
    expect(errorBanner(container)).toBeNull();
  });
});

describe('MangaSearchPage 停止搜索', () => {
  it('停止會關掉當前 stream、保留部分結果、不發後續批次，也不是錯誤', async () => {
    mockSourcesResponse({ sources: sourceList(12), probe: {}, maxSources: 12 });
    mockSearchParams = new URLSearchParams({ q: '海賊' });

    const { container } = render(<MangaSearchPage />);

    const first = await waitForStream(0);
    await deliver(first, sourceResult('s01'), sourceResult('s02'));
    await waitFor(() => expect(cardCount()).toBe(2));
    expect(screen.getByText('搜索中 2/12')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '停止搜索' }));
    await settle();

    expect(first.closed).toBe(true);
    // 尚未開始的兩批完全不發出
    expect(streams()).toHaveLength(1);
    // 已回來的結果留在畫面上
    expect(cardCount()).toBe(2);
    expect(screen.getByText('已停止搜索（2/12）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull();
    // 停止不是連線錯誤
    expect(errorBanner(container)).toBeNull();

    // 停止後仍能重新啟動一輪搜尋
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    const restarted = await waitForStream(1);
    expect(restarted.closed).toBe(false);
    expect(restarted.requestedSourceIds).toBe('s01,s02,s03,s04,s05');
    expect(screen.queryByText('已停止搜索（2/12）')).toBeNull();
    expect(
      screen.getByRole('button', { name: '停止搜索' })
    ).toBeInTheDocument();

    await deliver(restarted, sourceResult('s01'));
    await waitFor(() => expect(cardCount()).toBe(1));
  });
});

describe('MangaSearchPage render 窗口', () => {
  it('340 筆結果只畫前 96 張，按「显示更多」才擴到 192 張', async () => {
    // 窗口大小是這條 contract 的重點，先把它釘住
    expect(MANGA_RESULT_RENDER_PAGE_SIZE).toBe(96);

    mockSourcesResponse({ sources: sourceList(2), probe: {}, maxSources: 12 });
    mockSearchParams = new URLSearchParams({ q: '海賊' });

    render(<MangaSearchPage />);

    const first = await waitForStream(0);
    expect(first.requestedSourceIds).toBe('s01,s02');

    await deliver(
      first,
      sourceResult('s01', 200),
      sourceResult('s02', 140),
      batchComplete(2)
    );

    // 資料層保留全部 340 筆
    await waitFor(() =>
      expect(screen.getByText('搜索结果（340）')).toBeInTheDocument()
    );
    expect(cardCount()).toBe(MANGA_RESULT_RENDER_PAGE_SIZE);
    expect(
      screen.getByRole('button', { name: /显示更多（剩余 244）/ })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));

    await waitFor(() =>
      expect(cardCount()).toBe(MANGA_RESULT_RENDER_PAGE_SIZE * 2)
    );
    expect(
      screen.getByRole('button', { name: /显示更多（剩余 148）/ })
    ).toBeInTheDocument();
  });
});

describe('MangaSearchPage 來源清單退路', () => {
  it('來源清單 API 失敗＋URL 明確選 12 顆時，只發一個 server-counted request', async () => {
    const requested = sourceList(12).map((source) => source.id);
    mockSourcesResponse('reject');
    mockSearchParams = new URLSearchParams({
      q: '海賊',
      sourceIds: requested.join(','),
    });

    const { container } = render(<MangaSearchPage />);

    const first = await waitForStream(0);
    // 拿不到 maxSources 就不能自己拆批：那會讓每一批各吃一次 server 上限
    expect(first.requestedSourceIds.split(',')).toEqual(requested);

    // 分母改由伺服器回報（它可能依政策砍掉幾顆）
    await deliver(first, { type: 'start', totalSources: 8 });
    await waitFor(() =>
      expect(screen.getByText('搜索中 0/8')).toBeInTheDocument()
    );

    await deliver(
      first,
      ...requested.slice(0, 8).map((id) => sourceResult(id)),
      batchComplete(8)
    );
    await settle();

    expect(streams()).toHaveLength(1);
    await waitFor(() => expect(cardCount()).toBe(8));
    expect(errorBanner(container)).toBeNull();
  });

  it('明確選取的來源不在預設語言清單裡時，request 仍保留該來源 id', async () => {
    // 預設語言清單只有 s01／s02，s99 是使用者明確選的跨語言來源
    mockSourcesResponse({ sources: sourceList(2), probe: {}, maxSources: 12 });
    mockSearchParams = new URLSearchParams({ q: '海賊', sourceIds: 's99' });

    render(<MangaSearchPage />);

    const first = await waitForStream(0);
    expect(first.requestedSourceIds).toBe('s99');

    await deliver(first, sourceResult('s99'), batchComplete(1));
    await settle();

    expect(streams()).toHaveLength(1);
    // 授權由伺服器判定；前端不得先把它從 request 裡刪掉
    await waitFor(() => expect(cardCount()).toBe(1));
  });
});

describe('MangaSearchPage 錯誤中止', () => {
  it('伺服器回報錯誤後不再發下一批，並保留已回來的結果', async () => {
    mockSourcesResponse({ sources: sourceList(12), probe: {}, maxSources: 12 });
    mockSearchParams = new URLSearchParams({ q: '海賊' });

    const { container } = render(<MangaSearchPage />);

    const first = await waitForStream(0);
    await deliver(first, sourceResult('s01'), sourceResult('s02'), {
      type: 'error',
      error: '服务端拒绝了这次搜索',
    });
    await settle();

    expect(first.closed).toBe(true);
    expect(streams()).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByText('服务端拒绝了这次搜索')).toBeInTheDocument()
    );
    expect(cardCount()).toBe(2);
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull();
    expect(errorBanner(container)).not.toBeNull();
  });

  it('transport 中斷後不再發下一批，且講成錯誤而不是「已停止搜索」', async () => {
    mockSourcesResponse({ sources: sourceList(12), probe: {}, maxSources: 12 });
    mockSearchParams = new URLSearchParams({ q: '海賊' });

    const { container } = render(<MangaSearchPage />);

    const first = await waitForStream(0);
    await deliver(first, sourceResult('s01'));
    await breakTransport(first);
    await settle();

    expect(streams()).toHaveLength(1);
    await waitFor(() => expect(errorBanner(container)).not.toBeNull());
    expect(errorBanner(container)?.textContent).toBeTruthy();
    // 連線中斷不可偽裝成「沒有結果」，也不是使用者按的停止
    expect(cardCount()).toBe(1);
    expect(screen.queryByText(/已停止搜索/)).toBeNull();
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull();
  });
});

describe('MangaSearchPage 非流式與初始化退路', () => {
  it('fluidSearch=false 時同样按 5/5/2 请求 REST，并逐批累积结果', async () => {
    window.localStorage.setItem('fluidSearch', 'false');
    const sources = sourceList(12);
    const restRequests: string[][] = [];
    mutableGlobal.fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/manga/sources')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sources, probe: {}, maxSources: 12 }),
        });
      }
      if (url.startsWith('/api/manga/search?')) {
        const sourceIds = (
          new URL(url, 'http://localhost').searchParams.get('sourceIds') || ''
        ).split(',');
        restRequests.push(sourceIds);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: sourceIds.flatMap((id) => items(id, 1)),
              attemptedSources: sourceIds.length,
              failedSources: [],
              measurements: [],
            }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    });
    mockSearchParams = new URLSearchParams({ q: '海賊' });

    render(<MangaSearchPage />);

    await waitFor(() => expect(restRequests).toHaveLength(3));
    expect(restRequests.map((batch) => batch.length)).toEqual([5, 5, 2]);
    expect(restRequests.flat()).toEqual(sources.map((source) => source.id));
    await waitFor(() => expect(cardCount()).toBe(12));
    expect(streams()).toHaveLength(0);
  });

  it('来源 metadata 超时后仍启动 server-counted 搜索', async () => {
    jest.useFakeTimers();
    try {
      const requested = sourceList(12).map((source) => source.id);
      mutableGlobal.fetch = jest.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('/api/manga/sources')) {
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      });
      mockSearchParams = new URLSearchParams({
        q: '海賊',
        sourceIds: requested.join(','),
      });

      render(<MangaSearchPage />);
      expect(streams()).toHaveLength(0);

      // metadata 未 ready 前重按同一查询不会先发一轮，readiness 只会启动一次。
      fireEvent.click(screen.getByRole('button', { name: '搜索' }));
      expect(streams()).toHaveLength(0);

      await act(async () => {
        jest.advanceTimersByTime(2999);
        await Promise.resolve();
      });
      expect(streams()).toHaveLength(0);

      await act(async () => {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(streams()).toHaveLength(1);
      expect(streams()[0].requestedSourceIds.split(',')).toEqual(requested);
    } finally {
      jest.useRealTimers();
    }
  });

  it('裸搜索页在 metadata ready 后仍保留已保存的输入', async () => {
    window.sessionStorage.setItem(
      'manga_search_state',
      JSON.stringify({ query: '已保存关键字', sourceId: 's02' })
    );
    mockSourcesResponse({ sources: sourceList(2), probe: {}, maxSources: 12 });

    render(<MangaSearchPage />);

    const input = screen.getByPlaceholderText('搜索漫画标题、作者或绘师');
    await waitFor(() => expect(input).toHaveValue('已保存关键字'));
    await settle();
    expect(input).toHaveValue('已保存关键字');
    expect(streams()).toHaveLength(0);
  });
});
