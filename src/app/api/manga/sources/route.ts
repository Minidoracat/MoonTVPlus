import { NextRequest, NextResponse } from 'next/server';

import { getSuwayomiConfig, suwayomiClient } from '@/lib/suwayomi.client';

import { getAuthorizedUsername, mangaErrorResponse } from '../_utils';

/** BCP-47 樣式的語言標籤；用來擋掉會被當成快取 key 的任意字串 */
const LANG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const username = await getAuthorizedUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const rawLang = new URL(request.url).searchParams.get('lang');
    // lang 會進 getSources 的快取 key，必須先驗格式：
    // 否則可用 ?lang=<隨機字串> 迴圈灌爆快取並讓每次都 miss 打上游
    if (rawLang !== null && !LANG_PATTERN.test(rawLang)) {
      return NextResponse.json({ error: 'lang 参数格式无效' }, { status: 400 });
    }
    const lang = rawLang || process.env.SUWAYOMI_DEFAULT_LANG || 'zh';
    const [sources, config] = await Promise.all([
      suwayomiClient.getSources(lang),
      getSuwayomiConfig(),
    ]);
    // maxSources = 單次搜尋實際查詢的來源上限，前端用來提示多選超限
    return NextResponse.json({ sources, maxSources: config.maxSources });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
