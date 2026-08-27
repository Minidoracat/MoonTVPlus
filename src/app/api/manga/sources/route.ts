import { createHash } from 'crypto';

import { NextRequest, NextResponse } from 'next/server';

import { readMangaProbeCache } from '@/lib/manga-probe-cache.server';
import {
  toMangaSourceProbeSummary,
  type MangaSourceProbeSummary,
} from '@/lib/manga.types';
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
    // 政策不可信時不可列出全部來源：降級設定的 sourceIds 是空陣列，
    // getSources() 會回傳所有來源，等於把管理員刻意隱藏的（含 NSFW）源名
    // 洩漏到 picker UI。列表端點跟著授權邊界一起 fail closed。
    await suwayomiClient.assertPolicyKnown();
    const [sources, config, probeCache] = await Promise.all([
      suwayomiClient.getSources(lang),
      getSuwayomiConfig(),
      readMangaProbeCache(),
    ]);
    // maxSources = 單次搜尋實際查詢的來源上限，前端用來提示多選超限
    //
    // policyVersion = 兩份來源清單的短 hash。前端用它當 sessionStorage
    // 快取 key 的一部分：政策一變（管理員停用來源）舊快取就全部自然失效，
    // 不會再把已停用來源的結果重播出來。
    const policyVersion = createHash('sha256')
      .update(
        JSON.stringify([
          [...config.sourceIds].sort(),
          [...config.disabledSourceIds].sort(),
        ])
      )
      .digest('hex')
      .slice(0, 12);

    // 只對「這位使用者看得到的來源」附上探測摘要 —— sources 已經套過
    // 允許清單，用它當來源比對就不會洩漏被停用來源的存在。
    // 摘要不含錯誤訊息（見 toMangaSourceProbeSummary 的說明）。
    const probe: Record<string, MangaSourceProbeSummary> = {};
    for (const source of sources) {
      const entry = probeCache.entries[source.id];
      if (entry) probe[source.id] = toMangaSourceProbeSummary(entry);
    }

    return NextResponse.json({
      sources,
      maxSources: config.maxSources,
      policyVersion,
      probe,
      probedAt: probeCache.testedAt || null,
    });
  } catch (error) {
    return mangaErrorResponse(error);
  }
}
