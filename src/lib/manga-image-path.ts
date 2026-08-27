/**
 * Suwayomi 的合法圖片 endpoint。
 *
 * 圖片代理會附上管理員憑證去抓上游，若放任任意 path，
 * 任何有漫畫權限的使用者都能用管理員身分讀 Suwayomi 其他受保護的 GET 資源
 * （設定、備份、GraphQL 等）。因此只允許已知的圖片路徑。
 *
 * 每個 pattern 的第一個 capture group 必須是 mangaId。
 */
const ALLOWED_IMAGE_PATHS: Array<{ kind: 'thumbnail' | 'page'; re: RegExp }> = [
  // 封面：buildSuwayomiImageProxyUrl(manga.thumbnailUrl)
  { kind: 'thumbnail', re: /^\/api\/v1\/manga\/(\d+)\/thumbnail\/?$/ },
  // 內頁：fetchChapterPages 回傳的 pages
  {
    kind: 'page',
    re: /^\/api\/v1\/manga\/(\d+)\/chapter\/\d+\/page\/\d+\/?$/,
  },
];

/**
 * 從路徑取出 mangaId 與圖片種類；不符合白名單則回 null。
 *
 * 白名單只保證「這是圖片端點」，不保證「這本漫畫的來源仍被允許」——
 * path 裡的 mangaId 由客戶端提供，知道被停用來源的 id 就能直接讀圖，
 * 繞過 detail/pages 上的檢查。呼叫端仍要用這個 mangaId 反查來源做授權。
 *
 * kind 用來決定要不要縮圖：封面在列表裡只顯示約 200px 寬，
 * 內頁是閱讀主體，不可降畫質。
 */
function matchImagePath(
  pathname: string
): { mangaId: string; kind: 'thumbnail' | 'page' } | null {
  for (const { kind, re } of ALLOWED_IMAGE_PATHS) {
    const matched = re.exec(pathname);
    if (matched) return { mangaId: matched[1], kind };
  }
  return null;
}

/**
 * 把使用者給的 path 解析成上游圖片 URL，並回傳其 mangaId 與圖片種類。
 * 不合法就丟錯，呼叫端不需再自行驗證。
 */
export function resolveMangaImageUrl(
  serverBaseUrl: string,
  pathOrUrl: string
): { url: string; mangaId: string; kind: 'thumbnail' | 'page' } {
  const base = new URL(serverBaseUrl);
  // serverBaseUrl 可以帶 sub-path（normalizeApiBaseUrl 只去尾斜線），
  // 例如 https://host/suwayomi。白名單比對的是「去掉前綴後」的路徑。
  const basePath = base.pathname.replace(/\/+$/, '');
  // `\` 在 WHATWG URL 解析中等同 `/`，`\\evil.example/...` 會變成 protocol-relative
  const candidate = pathOrUrl.replace(/\\/g, '/');
  const target = /^https?:\/\//i.test(candidate)
    ? new URL(candidate)
    : new URL(
        `${basePath}${candidate.startsWith('/') ? candidate : `/${candidate}`}`,
        base
      );

  // 兩個分支都要檢查：`//attacker.example/api/v1/manga/1/thumbnail` 這種
  // protocol-relative 輸入經 new URL(..., base) 會解析成外部 origin，
  // pathname 卻仍符合白名單，若不擋就會把管理員憑證送到攻擊者主機。
  if (target.origin !== base.origin) {
    throw new Error('不允许代理非当前 Suwayomi 服务的地址');
  }

  // 絕對網址分支帶著 basePath 前綴，相對分支剛才才補上；兩者都要剝掉再比對
  if (basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new Error('不允许代理该路径');
  }
  const relativePath = basePath
    ? target.pathname.slice(basePath.length)
    : target.pathname;

  const matched = matchImagePath(relativePath);
  if (!matched) {
    throw new Error('不允许代理该路径');
  }

  return { url: target.toString(), mangaId: matched.mangaId, kind: matched.kind };
}
