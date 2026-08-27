import { createHash } from 'crypto';

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';
import { acceptsWebp } from '@/lib/http-accept';
import { resolveMangaImageUrl } from '@/lib/manga-image-path';
import {
  getSuwayomiConfig,
  loginWithSimpleAuth,
  suwayomiClient,
} from '@/lib/suwayomi.client';

export const runtime = 'nodejs';

/**
 * 封面縮圖寬度。
 *
 * 列表卡片實際顯示約 200px 寬，2x 螢幕需要 400px。取 360 是折衷：
 * 高解析裝置仍夠銳利，位元組卻遠低於上游原尺寸。
 */
const THUMBNAIL_WIDTH = 360;

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const pathOrUrl = new URL(request.url).searchParams.get('path')?.trim();
    if (!pathOrUrl) {
      return NextResponse.json({ error: '缺少 path 参数' }, { status: 400 });
    }

    const config = await getSuwayomiConfig();
    const { url: upstreamUrl, mangaId, kind } = resolveMangaImageUrl(
      config.serverBaseUrl,
      pathOrUrl
    );
    // path 裡的 mangaId 是客戶端給的，必須反查真正的來源再驗白名單，
    // 否則被停用來源的封面／內頁仍可直接讀出
    await suwayomiClient.assertMangaAllowed(mangaId);

    // 上游（Suwayomi）不提供 ETag 也不提供 Last-Modified，只給
    // `Cache-Control: max-age=86400`，所以無法轉送它的 validator。
    // ETag 只能從「實際輸出的位元組」算 —— 用 URL 當 ETag 是錯的：
    // 上游換了新封面後 ETag 不變，瀏覽器會永久沿用舊圖。
    // 因此 304 的判斷必須放在取得並轉檔完位元組之後。
    const wantsWebp = acceptsWebp(request.headers.get('accept'));
    const buildHeaders = async (
      forceRelogin: boolean
    ): Promise<HeadersInit | undefined> => {
      if (config.authMode === 'basic_auth') {
        if (!config.username || !config.password) {
          throw new Error('Suwayomi basic_auth 缺少用户名或密码');
        }

        return new Headers({
          Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
        });
      }

      if (config.authMode === 'simple_login') {
        return new Headers({
          Cookie: await loginWithSimpleAuth(config, forceRelogin),
        });
      }

      return undefined;
    };

    // redirect: 'manual' —— 上游若把請求導向別處，不可帶著管理員憑證跟過去
    let response = await fetch(upstreamUrl, {
      headers: await buildHeaders(false),
      cache: 'no-store',
      redirect: 'manual',
    });

    if (response.status === 401 && config.authMode === 'simple_login') {
      response = await fetch(upstreamUrl, {
        headers: await buildHeaders(true),
        cache: 'no-store',
        redirect: 'manual',
      });
    }

    if (response.status >= 300 && response.status < 400) {
      return NextResponse.json(
        { error: '不允许跟随上游重定向' },
        { status: 502 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: `Suwayomi 图片请求失败: ${response.status}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type');
    // 白名單已限定路徑，這裡再確認回應真的是圖片，
    // 避免上游改版後把 JSON／HTML 當圖片轉出去。
    //
    // 明確排除 SVG：它是可執行腳本的圖片型別，而本專案的登入 cookie 是
    // httpOnly: false，一個能執行腳本的同源回應等於可竊取 session。
    // Suwayomi 的封面／內頁都是點陣圖，拒絕 SVG 不影響正常功能。
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    if (!mime || !mime.startsWith('image/') || mime === 'image/svg+xml') {
      return NextResponse.json(
        { error: '上游返回的不是受支持的图片内容' },
        { status: 502 }
      );
    }

    // `no-cache` 不是「不要快取」，而是「可以存，但每次使用前必須回來驗證」。
    //
    // 這是唯一同時滿足兩個需求的設定：
    // - `max-age=N` 會讓瀏覽器在 N 秒內完全不送請求，`assertMangaAllowed`
    //   不會執行 —— 同一個 browser profile 在登出、換帳號、或來源剛被停用後
    //   仍能從私有 HTTP 快取回放封面，等於繞過授權。
    // - `no-store` 則連條件式請求都不給，閱讀器往回翻頁要重抓全部位元組。
    // `private` 另外擋掉 nginx／CDN 這類共享快取。
    const CACHE_CONTROL = 'private, no-cache';

    // 內頁直接串流轉送，不進記憶體。
    //
    // 算 ETag 必須先拿到完整位元組，而上游**不送 content-length**，所以無法
    // 事先判斷大小。內頁動輒數 MB、一次閱讀會連續抓很多張，整份 buffer 的
    // 記憶體用量會隨「併發數 × 圖片大小」無上限成長，足以拖垮同一個 Node
    // 程序上的登入與播放。
    //
    // 代價是內頁沒有 ETag、往回翻頁要重抓位元組 —— 但上游本來就不提供
    // validator，本次改動之前內頁也同樣沒有 ETag，所以不是退步。
    // 封面則相反：本質是小圖（實測上游 162KB），buffer 它才能縮圖，
    // 而縮圖省下的 72.7% 位元組遠超過這點記憶體。
    if (kind !== 'thumbnail') {
      const headers = new Headers();
      headers.set('content-type', mime);
      headers.set('x-content-type-options', 'nosniff');
      headers.set('cache-control', CACHE_CONTROL);
      return new NextResponse(response.body, { status: 200, headers });
    }

    // 封面在列表裡只顯示約 200px 寬，但上游給的是原尺寸 ——
    // 實測一頁 24 張封面共 1877KB。縮圖 + WebP 可大幅降低首屏位元組。
    let bytes = Buffer.from(await response.arrayBuffer());
    let outMime = mime;
    try {
      const pipeline = sharp(bytes, { failOn: 'none' })
        .rotate()
        .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true });
      const output = wantsWebp
        ? await pipeline.webp({ quality: 78 }).toBuffer()
        : await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      const outputMime = wantsWebp ? 'image/webp' : 'image/jpeg';

      // 「只有變小才採用」不能套在**為了相容性**而轉檔的情況：上游是 WebP、
      // 客戶端明確不接受 WebP，而 JPEG 重編碼後反而變大時，若因為變大就沿用
      // 原位元組，等於把 WebP 送給剛剛說不接受 WebP 的客戶端 —— 加上
      // nosniff，那就是一張破圖。相容性優先於位元組數。
      const mustConvert = !wantsWebp && mime === 'image/webp';
      if (mustConvert || output.length < bytes.length) {
        bytes = output;
        outMime = outputMime;
      }
    } catch (error) {
      // 轉檔失敗不影響顯示，退回原圖
      console.warn('封面缩图失败，改用原图:', error);
    }

    // ETag 從實際輸出的位元組算：上游換圖時它會跟著變，不會卡住舊圖。
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
    if (request.headers.get('if-none-match') === etag) {
      // 授權已在上面跑過，所以 304 只省位元組，不省授權
      return new NextResponse(null, {
        status: 304,
        headers: { etag, 'cache-control': CACHE_CONTROL },
      });
    }

    const headers = new Headers();
    headers.set('content-type', outMime);
    // 禁止瀏覽器 MIME sniffing：即使上游標成 image/*，內容若像 HTML
    // 也不可被當成文件執行
    headers.set('x-content-type-options', 'nosniff');
    headers.set('etag', etag);
    headers.set('cache-control', CACHE_CONTROL);

    return new NextResponse(bytes, {
      status: 200,
      headers,
    });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
