import { resolveMangaImageUrl } from '@/lib/manga-image-path';

const ROOT = 'http://suwayomi.local:4567';
const SUBPATH = 'https://host.example/suwayomi';

describe('resolveMangaImageUrl', () => {
  describe('合法圖片路徑', () => {
    it('封面（相對路徑，root 部署）', () => {
      expect(resolveMangaImageUrl(ROOT, '/api/v1/manga/1307/thumbnail')).toEqual({
        url: `${ROOT}/api/v1/manga/1307/thumbnail`,
        mangaId: '1307',
      });
    });

    it('內頁（相對路徑，root 部署）', () => {
      expect(
        resolveMangaImageUrl(ROOT, '/api/v1/manga/21/chapter/1/page/0')
      ).toEqual({
        url: `${ROOT}/api/v1/manga/21/chapter/1/page/0`,
        mangaId: '21',
      });
    });

    it('缺前導斜線也接受', () => {
      expect(
        resolveMangaImageUrl(ROOT, 'api/v1/manga/9/thumbnail').mangaId
      ).toBe('9');
    });
  });

  // normalizeApiBaseUrl 只去尾斜線，所以 https://host/suwayomi 是合法設定。
  // 本機 serverBaseUrl 沒有前綴，這組情境只能靠單元測試守住。
  describe('sub-path 部署', () => {
    it('相對路徑要補上 base 前綴', () => {
      expect(
        resolveMangaImageUrl(SUBPATH, '/api/v1/manga/1307/thumbnail')
      ).toEqual({
        url: 'https://host.example/suwayomi/api/v1/manga/1307/thumbnail',
        mangaId: '1307',
      });
    });

    it('絕對網址帶前綴時要剝掉前綴再比對白名單', () => {
      expect(
        resolveMangaImageUrl(
          SUBPATH,
          'https://host.example/suwayomi/api/v1/manga/42/chapter/3/page/7'
        )
      ).toEqual({
        url: 'https://host.example/suwayomi/api/v1/manga/42/chapter/3/page/7',
        mangaId: '42',
      });
    });

    it('前綴外的同 origin 路徑要拒絕', () => {
      expect(() =>
        resolveMangaImageUrl(
          SUBPATH,
          'https://host.example/api/v1/manga/1/thumbnail'
        )
      ).toThrow('不允许代理该路径');
    });

    it('尾斜線的 base 不會產生雙斜線', () => {
      expect(
        resolveMangaImageUrl(`${SUBPATH}/`, '/api/v1/manga/5/thumbnail').url
      ).toBe('https://host.example/suwayomi/api/v1/manga/5/thumbnail');
    });
  });

  describe('拒絕非圖片端點', () => {
    it.each([
      ['/api/graphql'],
      ['/api/v1/settings/about'],
      ['/api/v1/backup/export'],
      ['/api/v1/manga/1/thumbnail/../../../graphql'],
      ['/api/v1/manga/abc/thumbnail'],
      ['/api/v1/manga/1/chapter/1/page'],
    ])('拒絕 %s', (path) => {
      expect(() => resolveMangaImageUrl(ROOT, path)).toThrow('不允许代理该路径');
    });
  });

  describe('拒絕跨 origin（避免管理員憑證外流）', () => {
    it.each([
      ['絕對外部網址', 'http://attacker.example/api/v1/manga/1/thumbnail'],
      ['protocol-relative', '//attacker.example/api/v1/manga/1/thumbnail'],
      ['反斜線變體', '\\\\attacker.example/api/v1/manga/1/thumbnail'],
    ])('拒絕 %s', (_label, path) => {
      expect(() => resolveMangaImageUrl(ROOT, path)).toThrow(
        '不允许代理非当前 Suwayomi 服务的地址'
      );
    });
  });
});
