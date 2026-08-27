import { createHash } from 'crypto';

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';
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
    const wantsWebp = (request.headers.get('accept') || '').includes(
      'image/webp'
    );
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

    // 封面在列表裡只顯示約 200px 寬，但上游給的是原尺寸 ——
    // 實測一頁 24 張封面共 1877KB。縮圖 + WebP 可大幅降低首屏位元組。
    // 內頁是閱讀主體，絕不降畫質。
    let bytes = Buffer.from(await response.arrayBuffer());
    let outMime = mime;
    if (kind === 'thumbnail') {
      try {
        const pipeline = sharp(bytes, { failOn: 'none' })
          .rotate()
          .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true });
        const output = wantsWebp
          ? await pipeline.webp({ quality: 78 }).toBuffer()
          : await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        // 只有真的變小才採用，避免小圖被轉大
        if (output.length < bytes.length) {
          bytes = output;
          outMime = wantsWebp ? 'image/webp' : 'image/jpeg';
        }
      } catch (error) {
        // 轉檔失敗不影響顯示，退回原圖
        console.warn('封面缩图失败，改用原图:', error);
      }
    }

    // ETag 從實際輸出的位元組算：上游換圖時它會跟著變，不會卡住舊圖。
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
    if (request.headers.get('if-none-match') === etag) {
      // 授權已在上面跑過，所以 304 只省位元組，不省授權
      return new NextResponse(null, {
        status: 304,
        headers: { etag, 'cache-control': 'private, no-cache' },
      });
    }

    const headers = new Headers();
    headers.set('content-type', outMime);
    // 禁止瀏覽器 MIME sniffing：即使上游標成 image/*，內容若像 HTML
    // 也不可被當成文件執行
    headers.set('x-content-type-options', 'nosniff');
    headers.set('etag', etag);
    // `no-cache` 不是「不要快取」，而是「可以存，但每次使用前必須回來驗證」。
    //
    // 這是唯一同時滿足兩個需求的設定：
    // - `max-age=N` 會讓瀏覽器在 N 秒內完全不送請求，`assertMangaAllowed`
    //   不會執行 —— 同一個 browser profile 在登出、換帳號、或來源剛被停用後
    //   仍能從私有 HTTP 快取回放封面，等於繞過授權。
    // - `no-store` 則連條件式請求都不給，閱讀器往回翻頁要重抓全部位元組。
    // `no-cache` 讓每次使用都經過本 route 的授權，而未變更的圖用 304 回應，
    // 不重傳位元組。`private` 另外擋掉 nginx／CDN 這類共享快取。
    headers.set('cache-control', 'private, no-cache');

    return new NextResponse(bytes, {
      status: 200,
      headers,
    });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
