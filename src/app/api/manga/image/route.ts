import { NextRequest, NextResponse } from 'next/server';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';
import { resolveMangaImageUrl } from '@/lib/manga-image-path';
import {
  getSuwayomiConfig,
  loginWithSimpleAuth,
  suwayomiClient,
} from '@/lib/suwayomi.client';

export const runtime = 'nodejs';


export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const pathOrUrl = new URL(request.url).searchParams.get('path')?.trim();
    if (!pathOrUrl) {
      return NextResponse.json({ error: '缺少 path 参数' }, { status: 400 });
    }

    const config = await getSuwayomiConfig();
    const { url: upstreamUrl, mangaId } = resolveMangaImageUrl(
      config.serverBaseUrl,
      pathOrUrl
    );
    // path 裡的 mangaId 是客戶端給的，必須反查真正的來源再驗白名單，
    // 否則被停用來源的封面／內頁仍可直接讀出
    await suwayomiClient.assertMangaAllowed(mangaId);
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

    const headers = new Headers();
    headers.set('content-type', mime);
    // 禁止瀏覽器 MIME sniffing：即使上游標成 image/*，內容若像 HTML
    // 也不可被當成文件執行
    headers.set('x-content-type-options', 'nosniff');
    // `private` 已足以禁止 nginx／CDN 這類共享快取儲存（那才是真正的威脅）。
    // 不用 no-store：那會連瀏覽器快取一起關掉，閱讀器往回翻頁時每張圖都要
    // 重新下載並重打本 route 與上游 Suwayomi。安全性沒有損失 —— 能重用快取
    // 影像的只有先前已被授權看過該圖的同一使用者。
    // 也不轉送上游的 cache-control（可能是 public）。
    headers.set('cache-control', 'private, max-age=300');

    return new NextResponse(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
