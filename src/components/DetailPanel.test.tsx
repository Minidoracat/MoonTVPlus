/**
 * 點卡片先開詳情（本 fork 客製）：播放鈕只在詳情面板裡。只能靠 TMDB 查的片子
 * （沒有豆瓣 id，例如特殊源）一旦 TMDB 與豆瓣片名都查不到，面板只剩錯誤訊息，
 * 從卡片就沒辦法播放。播放不依賴詳情資料，錯誤狀態也要有播放鈕。
 */
import { fireEvent, render, screen } from '@testing-library/react';

import DetailPanel from '@/components/DetailPanel';

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
  ) as unknown as typeof fetch;
});

it.each([false, true])(
  '查不到詳情時仍可播放（useDrawer=%s）',
  async (useDrawer) => {
    const onPlay = jest.fn();
    render(
      <DetailPanel
        isOpen
        onClose={jest.fn()}
        title='只有特殊源的片子'
        onPlay={onPlay}
        playLabel='继续播放'
        useDrawer={useDrawer}
      />
    );

    expect(await screen.findByText('搜索失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续播放' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  }
);
