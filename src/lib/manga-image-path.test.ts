import { resolveMangaImageUrl } from '@/lib/manga-image-path';

const BASE = 'http://suwayomi:4567';

describe('resolveMangaImageUrl 允許的圖片端點', () => {
  it('接受封面並取出 mangaId', () => {
    expect(resolveMangaImageUrl(BASE, '/api/v1/manga/1307/thumbnail')).toEqual({
      url: 'http://suwayomi:4567/api/v1/manga/1307/thumbnail',
      mangaId: '1307',
    });
  });

  it('接受內頁並取出 mangaId（非章節或頁碼）', () => {
    expect(
      resolveMangaImageUrl(BASE, '/api/v1/manga/42/chapter/7/page/3')
    ).toEqual({
      url: 'http://suwayomi:4567/api/v1/manga/42/chapter/7/page/3',
      mangaId: '42',
    });
  });

  it('接受省略開頭斜線的路徑', () => {
    expect(
      resolveMangaImageUrl(BASE, 'api/v1/manga/5/thumbnail').mangaId
    ).toBe('5');
  });

  it('接受同源的絕對網址', () => {
    expect(
      resolveMangaImageUrl(BASE, 'http://suwayomi:4567/api/v1/manga/9/thumbnail')
        .mangaId
    ).toBe('9');
  });
});

describe('resolveMangaImageUrl 拒絕非圖片端點', () => {
  // 這個代理會附上管理員憑證，放行任意 path 等於讓任何有漫畫權限的使用者
  // 用管理員身分讀 Suwayomi 其他受保護的 GET 資源
  it.each([
    ['GraphQL', '/api/graphql'],
    ['設定', '/api/v1/settings/about'],
    ['備份', '/api/v1/backup/export'],
    ['非數字 mangaId', '/api/v1/manga/abc/thumbnail'],
    ['多餘路徑段', '/api/v1/manga/1/thumbnail/extra'],
    ['matrix param', '/api/v1/manga/1;x/thumbnail'],
  ])('拒絕 %s', (_label, input) => {
    expect(() => resolveMangaImageUrl(BASE, input)).toThrow('不允许代理该路径');
  });

  it('路徑穿越在比對前已被正規化，收斂後不符白名單', () => {
    expect(() =>
      resolveMangaImageUrl(BASE, '/api/v1/manga/1/thumbnail/../../../graphql')
    ).toThrow('不允许代理该路径');
  });
});

describe('resolveMangaImageUrl 強制同源', () => {
  // 任何逃出 Suwayomi origin 的輸入都會把管理員憑證送到別的主機
  it.each([
    ['絕對外部網址', 'http://evil.example/api/v1/manga/1/thumbnail'],
    ['protocol-relative', '//evil.example/api/v1/manga/1/thumbnail'],
    ['反斜線變體', '\\\\evil.example/api/v1/manga/1/thumbnail'],
    ['userinfo 偽裝', 'http://suwayomi:4567@evil.example/api/v1/manga/1/thumbnail'],
    ['不同 port', 'http://suwayomi:9999/api/v1/manga/1/thumbnail'],
    ['不同 scheme', 'https://suwayomi:4567/api/v1/manga/1/thumbnail'],
  ])('拒絕 %s', (_label, input) => {
    expect(() => resolveMangaImageUrl(BASE, input)).toThrow(
      '不允许代理非当前 Suwayomi 服务的地址'
    );
  });
});

describe('resolveMangaImageUrl 處理帶 sub-path 的 serverBaseUrl', () => {
  const SUB = 'http://host/suwayomi';

  it('相對路徑會補上 base 的 sub-path', () => {
    expect(resolveMangaImageUrl(SUB, '/api/v1/manga/3/thumbnail')).toEqual({
      url: 'http://host/suwayomi/api/v1/manga/3/thumbnail',
      mangaId: '3',
    });
  });

  it('絕對網址需帶 sub-path 前綴才通過', () => {
    expect(
      resolveMangaImageUrl(SUB, 'http://host/suwayomi/api/v1/manga/3/thumbnail')
        .mangaId
    ).toBe('3');
  });

  it('繞過 sub-path 前綴的同源路徑仍被拒', () => {
    expect(() =>
      resolveMangaImageUrl(SUB, 'http://host/api/v1/manga/3/thumbnail')
    ).toThrow('不允许代理该路径');
  });
});
