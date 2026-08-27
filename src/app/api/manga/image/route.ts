import { createHash } from 'crypto';

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';
import { readAllBounded } from '@/lib/bounded-read';
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

/**
 * 封面允許讀進記憶體的位元組上限。
 *
 * 上游**不送 content-length**（已實測），所以無法先看大小再決定 ——
 * 只能邊讀邊累計，超過就放棄。白名單只保證 URL 是
 * `/api/v1/manga/<id>/thumbnail`，不保證回應多大：任一被允許但故障或惡意的
 * 來源都可以在這個端點回一個沒有 content-length 的巨大 chunked body，
 * 而封面是一次載入 24 張。少了上界，登入與播放共用的同一個 Node 程序
 * 可以被少量超大封面打到 OOM。
 *
 * 8MB 對「一張漫畫封面」已經非常寬鬆（實測上游原圖 162KB）。
 */
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/**
 * sharp 解碼的像素上限。
 *
 * 位元組上限擋不住 decompression bomb：壓縮後幾百 KB 的圖可以解成數 GB。
 * sharp 預設是 268MP（約 800MB 記憶體），對封面用途遠超所需。
 * 40MP 足以容納任何合理的封面原圖（例如 5000×8000）。
 */
const MAX_THUMBNAIL_PIXELS = 40 * 1000 * 1000;

/**
 * 所有瀏覽器都能解的圖片格式。
 *
 * 不在此列的上游格式（WebP／AVIF／HEIC／JXL…）若客戶端沒有明確表示接受，
 * 就**必須**轉檔，不能因為「轉出來比較大」而沿用原位元組。
 */
const UNIVERSALLY_DECODABLE = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
]);

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

    // 上游沒有 body（HTTP 允許 204/205 這類回應）時不能當成 200 轉出去，
    // 否則客戶端拿到一個 content-type 是 image/* 的空回應 —— 破圖。
    if (!response.body) {
      return NextResponse.json(
        { error: '上游返回的图片内容为空' },
        { status: 502 }
      );
    }

    // 內頁直接串流轉送，不進記憶體。
    //
    // 算 ETag 必須先拿到完整位元組，而上游**不送 content-length**，所以無法
    // 事先判斷大小。內頁動輒數 MB、一次閱讀會連續抓很多張，整份 buffer 的
    // 記憶體用量會隨「併發數 × 圖片大小」無上限成長，足以拖垮同一個 Node
    // 程序上的登入與播放。
    //
    // 兩個明示取捨：
    // 1. 內頁沒有 ETag，往回翻頁要重抓位元組 —— 但上游本來就不提供
    //    validator，本功能之前內頁也同樣沒有 ETag，所以不是退步。
    // 2. 內頁**不做內容協商**，原樣轉送上游的 mime。串流狀態下要協商就得先
    //    buffer，那正是這裡要避免的事。閱讀畫質不可降，而內頁格式由來源決定，
    //    實測都是 JPEG。
    if (kind !== 'thumbnail') {
      const headers = new Headers();
      headers.set('content-type', mime);
      headers.set('x-content-type-options', 'nosniff');
      headers.set('cache-control', CACHE_CONTROL);
      return new NextResponse(response.body, { status: 200, headers });
    }

    // 封面在列表裡只顯示約 200px 寬，但上游給的是原尺寸 ——
    // 實測一頁 24 張封面共 1877KB。縮圖 + WebP 可大幅降低首屏位元組。
    const original = await readAllBounded(response.body, MAX_THUMBNAIL_BYTES);
    if (!original) {
      console.warn(
        `封面超过 ${MAX_THUMBNAIL_BYTES} bytes，已拒绝: ${mangaId}`
      );
      return NextResponse.json({ error: '上游封面过大' }, { status: 502 });
    }

    // 客戶端能不能解上游這個格式。不能，就必須轉檔 —— 即使轉出來更大。
    //
    // 先前只特判 `mime === 'image/webp'`，漏掉同一類的其他格式：上游是 AVIF、
    // 客戶端送 `Accept: image/webp`（支援 WebP 但不支援 AVIF）時，AVIF 通常
    // 比 WebP 小，size gate 會沿用原 AVIF 並回報 image/avif，配上 nosniff
    // 就是破圖 —— 正是這段程式碼本來要防的事。
    // 實測（sharp 0.34.5，360×520 平滑影像）：AVIF q50 1458B、
    // 對應 JPEG 輸出 6741B，size gate 必然選錯。
    const outputMime = wantsWebp ? 'image/webp' : 'image/jpeg';
    const mustConvert =
      mime !== outputMime && !UNIVERSALLY_DECODABLE.has(mime);

    let bytes = original;
    let outMime = mime;
    try {
      const pipeline = sharp(original, {
        failOn: 'none',
        limitInputPixels: MAX_THUMBNAIL_PIXELS,
      })
        .rotate()
        .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true });
      const output = wantsWebp
        ? await pipeline.webp({ quality: 78 }).toBuffer()
        : await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();

      if (mustConvert || output.length < original.length) {
        bytes = output;
        outMime = outputMime;
      }
    } catch (error) {
      // 轉檔只是為了省位元組時，失敗就退回原圖 —— 原格式客戶端本來就能解。
      // 但轉檔是相容性的**必要條件**時，退回原圖等於保證送出一張客戶端
      // 解不開的圖，還會被 ETag 與快取當成正常內容。這種情況要明確失敗。
      console.warn('封面缩图失败:', error);
      if (mustConvert) {
        return NextResponse.json(
          { error: '封面转码失败，且原格式客户端无法解码' },
          { status: 502 }
        );
      }
    }

    // ETag 從實際輸出的位元組算：上游換圖時它會跟著變，不會卡住舊圖。
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
    if (request.headers.get('if-none-match') === etag) {
      // 授權已在上面跑過，所以 304 只省位元組，不省授權
      return new NextResponse(null, {
        status: 304,
        headers: {
          etag,
          'cache-control': CACHE_CONTROL,
          // 與 200 一致：快取據此更新已存的 header
          'x-content-type-options': 'nosniff',
        },
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
