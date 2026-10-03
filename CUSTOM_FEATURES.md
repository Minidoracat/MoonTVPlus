# 客製功能清單

> 本 fork 的客製功能總覽。每節列出該功能「新增的檔案」與「修改的上游檔案及區塊」，
> 供未來合併上游（`git merge upstream/main`）解衝突時對照：衝突發生在下列區塊時，
> 原則是 **保留本清單描述的客製區塊 + 接受上游的其他改動**。
>
> 所有客製 commit 統一使用 `feat(custom):` 前綴，可用 `git log --grep="(custom)"` 列出。

合併衝突先看本檔，不要只看 `docs/local-customizations.md`。PWA 五檔與繁中／別名同等優先。

**衝突熱檔（先留客製區塊，再吃上游其餘改動）**

| 檔案 | 必留客製 |
|---|---|
| `src/app/play/page.tsx` | iOS PWA PiP／`disablePictureInPicture`、廣告誤跳集、豆瓣失敗 TMDB 補資料；同時留鴻蒙 HLS、`crossOrigin` |
| `src/app/web-live/page.tsx` | PWA Safari fallback |
| `src/app/globals.css` | PWA／mobile 控制列 safe-area |
| `src/lib/ios-pwa.ts` | 整檔本地 |
| `src/components/PwaSafariPrompt.tsx` | 整檔本地 |
| `src/app/search/page.tsx`、`src/app/api/search/route.ts`、`src/app/api/search/ws/route.ts` | alias／人物模式；`privateOnly` 不送 alias |
| `src/components/UserMenu.tsx` | 繁中開關、三地片名（恢復預設 = 開） |
| `src/app/layout.tsx` | `<TraditionalChineseProvider />`、`<ActivityLogger />` |
| `src/components/VideoCard.tsx` | 點擊先開詳情 |
| `src/app/douban/page.tsx`、`src/components/DoubanSelector.tsx` | Netflix／TMDB 榜；同時留時刻表 |
| `next.config.js` | **不要**把 server `opencc-js` alias 成 identity |
| `docker-compose.yml` | 保留 `moontv-shared`（MoonTV 建立、Suwayomi 以 external 加入）與 core 的 `networks` |
| `src/app/api/douban-comments/route.ts` | 整檔改寫：先讀 Kvrocks 落地，不足才爬；存儲不支援時 `passthrough` 直連 |
| `src/lib/douban-anti-crawler.ts` | 頂部豆瓣請求閘門（`throughGate`／`localResponse`／`markRateLimited`／`isDoubanBlocked`）；`fetchDoubanWithVerification` 薄包裝 + `fetchDoubanOnce`；每個 fetch 的 `AbortSignal.timeout` |
| `src/lib/redis-base.db.ts`、`src/lib/types.ts` | `dc:*` 短評落地方法與 `IStorage` 可選方法／`DoubanComment*` 型別 |
| `src/app/api/cron/[password]/route.ts` | `refreshRecordAndFavorites` 末尾的 `prewarmDoubanComments` |
| `src/app/api/douban-recommendations/route.ts` | `!response.ok` 時轉發 `Retry-After` |
| `jest.config.js` | `moduleNameMapper` 的 `^cheerio/slim$`（jest 27 不認 exports 子路徑） |
| `src/app/manga/page.tsx` | 捲動只讀寫 `document.body.scrollTop`；瀏覽狀態在 layout effect cleanup 存；`appendUniqueMangas`；`pickDefaultMangaSourceId`；卡片 href 用 `buildMangaDetailHref`；picker 的 `egress`；推荐類型的本日／本周／本月（`findMangaHotWindows`／`matchMangaHotWindow`） |
| `src/app/manga/detail/page.tsx`、`src/app/manga/read/page.tsx` | `orderMangaChapters`、章節分批與 `prefetch={false}`、`MangaChapterOrderToggle`、`useOverlayFocus`；同目錄 `loading.tsx` 不可刪；閱讀器雙擊放大、第一頁問上一話、`startPage=last`；詳情頁讀到一半的那一話續讀、「继续阅读」為主按鈕 |
| `src/app/manga/search/page.tsx`、`src/app/manga/shelf/page.tsx`、`src/components/manga/MangaHistoryCard.tsx`、`src/components/manga/MangaLayout.tsx` | 詳情連結一律 `buildMangaDetailHref`；MangaLayout 的 skip link 與源管理 `useOverlayFocus` |
| `src/lib/suwayomi.client.ts` | `chapterPagesCache`；`uploadDate` 轉數字；詳情 `sourceName` 退回伺服器來源名；列表與摘要查 `latestUploadedChapter { id pageCount }` 產生 `singleChapter`；`getSourceEgressForAdmin` |
| `src/components/MangaCard.tsx` | `block`、`showSource`／`meta`／`progress`；hover 只給 `(hover:hover)`、動畫 `motion-safe:` |

## 1. 全站繁體中文介面

簡體 → 台灣正體（OpenCC `cn→twp`，含台灣用語轉換）的全站即時轉換，
涵蓋靜態 UI 與動態內容（豆瓣資料、搜尋結果、彈窗等）。未手動設定時依瀏覽器
系統語系（zh-TW / zh-HK / zh-MO / zh-Hant）自動啟用；手動設定永遠優先。

**新增檔案（零衝突風險）**
- `src/lib/opencc-client.ts` — 共用 OpenCC 轉換器單例
- `src/components/TraditionalChineseProvider.tsx` — DOM 轉換核心（TreeWalker 初掃 + MutationObserver 持續轉換）、語系偵測、設定讀寫 helper

**修改的上游檔案**
- `src/app/layout.tsx` — import + `<TraditionalChineseProvider />` 掛載（2 行，位於 `<TokenRefreshManager />` 之後）

**必守**：`TraditionalChineseProvider` 的屬性轉換要記住自己寫入的值（`lastWrittenAttrs`），跟文字節點的 `lastWritten` 一樣。
OpenCC twp 不是冪等的（`算法`→`演算法`，再轉一次又多一個「演」），少了這道檢查，寫入觸發 observer 後會在 microtask 裡無限迴圈：
標題含「演算法」的漫畫卡片一出現，iPhone 上整頁變黑、點什麼都沒反應（`TraditionalChineseProvider.test.tsx` 守著）。
`opencc-client.ts` 另把三條會再包住原詞的台灣用語（演算法、虛擬機器、真實模式）收回，避免顯示成「演演算法」。

## 2. 語系快速切換按鈕與設定開關

右上角「简/繁」圓形按鈕（樣式仿 `ThemeToggle`），與設定面板「繁体中文界面」
開關雙向同步（透過 `interfaceTraditionalChineseChanged` 自訂事件）。

**新增檔案**
- `src/components/LanguageToggle.tsx`

**修改的上游檔案**
- `src/components/PageLayout.tsx`、`src/components/MobileHeader.tsx`、
  `src/app/login/page.tsx`、`src/app/register/page.tsx`、`src/app/oidc-register/page.tsx`、
  `src/components/manga/MangaLayout.tsx`、`src/components/books/BooksLayout.tsx`
  — 各加 1 行 import + 在 `<ThemeToggle />` 旁掛 `<LanguageToggle />`（auth 頁外層 div 加 `flex items-center gap-2`）
- `src/components/UserMenu.tsx`（⚠ 上游高頻改動檔，最大衝突點）：
  - import `TraditionalChineseProvider` 的 helpers
  - state `interfaceTraditionalChinese` + 載入邏輯 + 事件同步 useEffect
  - handler `handleInterfaceTraditionalChineseToggle`（連動開啟「搜索繁体转简体」）
  - 通用設置區「繁体中文界面」開關 UI（位於「搜索繁体转简体」之後）
  - 恢復默認：`removeItem(TRADITIONAL_CHINESE_STORAGE_KEY)`（回到自動偵測）

## 3. 三地片名別名搜尋

搜尋時透過豆瓣（`subject_suggest` 定位 → rexxar subject 詳情取「又名」）把
中港台不同譯名展開為多關鍵詞一併查詢資源站（如 刺激1995 ↔ 肖申克的救赎 ↔ 月黑高飞）。
解析失敗 4 秒降級、失敗負快取 5 分鐘、成功快取 24 小時；關鍵詞對單站串行查詢避免觸發 WAF。

**新增檔案**
- `src/lib/title-alias.ts` — 別名解析 + `searchFromApiWithQueries`（多關鍵詞去重合併；**不修改** `searchFromApi` 本身）

**修改的上游檔案**
- `src/app/api/search/route.ts` — `alias=1` 參數、`queriesPromise` 並行解析、回應加 `aliases` 欄位、改呼叫 `searchFromApiWithQueries`。v225 起 `privateOnly=1` 時強制跳過別名解析（別名只 fan-out 公開 CMS）。
- `src/app/api/search/ws/route.ts` — 同上 + SSE `aliases` 事件；完成事件必須走本地 `maybeEmitComplete()`（設 `streamClosed`），不可退回上游分散的 `maybeComplete`。
- `src/app/search/page.tsx` — 請求帶 `&alias=1`、`searchAliases` state/ref、
  `titleContainsQuery` 精確搜尋過濾接受別名命中、`SearchCachePayload` 加選用 `aliases` 欄位；
  片名/人物模式切換與上游「高级」面板、`privateOnly=1` 並存。只搜私人影庫時不送 alias。
- `src/components/UserMenu.tsx` — 通用設置區「三地片名搜索」開關（state / 載入 / handler / UI / 重置）

## 4. 點選影片先開詳情

- `src/components/VideoCard.tsx` — 非 live 的 `handleClick` 開 `DetailPanel`，海報 `pointerEvents: none` 交給外層。
  合上游時保留此行為，同時接受圖片層 `overflow-hidden rounded-lg`（避免來源角標被裁切）。

## 5. Netflix / TMDB 熱門與官方 Top 10

- 新增：`src/app/api/netflix/top10/route.ts`、`src/lib/netflix-top10.ts`、`src/app/api/tmdb/hot/route.ts`
- `src/components/DoubanSelector.tsx` — `NETFLIX_PRIMARY` / `TMDB_HOT_PRIMARY`；v225 再加 `viewMode=grid|schedule`
- `src/app/douban/page.tsx` — Netflix 官方周榜卡片走 TMDB 路徑；時刻表與 loadError/pending 空狀態並存
- `src/lib/tmdb.client.ts` — 保留 `getTMDBHotList` / `fetchTMDBHot`，接受上游 `safeFetch` 與可設定圖片域名

## 6. 播放器客製

### iOS PWA 控制列與 PiP fallback

- 功能 commit：`3b8509cc Improve iOS PWA player controls`（後續還有網頁全螢幕修正）
- Safari 網頁模式可 PiP；iOS 加到主畫面的 PWA 不支援 programmatic PiP，改顯示「用 Safari 開啟／分享／複製連結」
- PWA／mobile 控制列 safe-area，避免右下角全螢幕鈕被圓角擋住

**檔案（衝突時優先留本地，再整合上游）**
- `src/lib/ios-pwa.ts`
- `src/components/PwaSafariPrompt.tsx`
- `src/app/play/page.tsx` — `disablePictureInPicture: !supportsProgrammaticPiP`、`<PwaSafariPrompt />`
- `src/app/web-live/page.tsx`
- `src/app/globals.css`

**同步後必查**
- `/play` Safari 網頁模式 PiP 可用
- `/play` iOS PWA 不顯示會報錯的 PiP 鈕，有 Safari fallback
- `/web-live` 同樣套用 PWA fallback
- 手機 PWA 右下角全螢幕鈕可點

### 廣告誤跳集

- `src/lib/playback-auto-next.ts`；短劇 `duanju=1` 例外
- v225 同時保留上游鴻蒙原生 HLS／`crossOrigin: 'anonymous'`

## 7. 其他必須鎖住

- `scripts/init-turso.js`：未設 USERNAME/PASSWORD 時拒絕建立 owner
- Cloudflare：不要在 `next.config.js` 的 `isEdgeBuild` 区块把 `opencc-js` alias 成 identity（该区块对 client 也生效，会弄坏繁中）。
  若真要压 Worker 体量，只准 `isEdgeBuild && isServer`，并接受 title-alias 跨字形在 CF 上退化。
  2026-08-27 `localstorage` CF build：`.open-next/server-functions/default/handler.mjs` gzip 3.40MB；字典不在 handler，而在 sibling server chunks（`㑯 㑔` 可命中，约 2×1.1MB）。来源是 title-alias 服务端动态 import，不是弹幕模块。本机部署是 Docker＋Kvrocks；若上 CF 需再验整包体积。

## 8. 豆瓣短評本地落地

- 新增：`src/lib/douban-comments.ts`（解析、`ensureDoubanComments`、`prewarmDoubanComments`）、`src/lib/douban-comments.test.ts`（閘門 3／存儲 3／狀態機與路由 13，共 19 案）、`jest.node-fetch-env.js`（jest 27 缺 fetch globals 的測試環境；`jest-environment-node@27.5.1` 已列 devDependency）
- 目的：按需爬、本地翻頁；同一頁只向豆瓣要一次，之後翻頁不出網；累積去重、重抓時更新 votes；被擋時仍有資料可看。
- Kvrocks key（僅 Redis 系後端，SQL／localstorage 走 `passthrough` 直連，語義同舊實作）：
  - `dc:<doubanId>:items` hash，commentId → JSON，重抓 upsert（先寫 items 再 ZADD，任一步中斷重試不重加、不改序）
  - `dc:<doubanId>:list` zset，score = 插入序號、member = commentId，前端 `start` 是這裡的 rank；`count` 一律取 ZCARD
  - `dc:<doubanId>:meta` hash：`nextStart`（對豆瓣的 offset 游標）、`exhausted`、`retryAfter`、`fetchedAt`、`total`、`count`
- 抓取規則：
  - 距上次成功抓取超過 7 天、且開首頁時 → 回豆瓣 `start=0` 合併；抓到「後頁」則清掉舊的 `exhausted`
  - 單次請求最多翻 2 頁；同一片的請求串行，後到者等前者結束後按自己的 `needCount` 再判斷
  - 游標：滿頁 `nextStart += 20`；不滿的尾頁只 `+= 實際條數`，避免整段跳過新增評論。`sort=new_score` 會隨投票重排，offset 不是精確接續：重疊由 id 去重吸收；被重排跳過的中段評論不會自動補回，只有浮上首頁前 20 的會在 7 天刷新時補入
  - 200 且有 `#comments` 容器但 0 則 = 合法空頁（成功、`exhausted`；首頁無「後頁」亦視為到底）；沒有 `#comments` 的 0 則（登入牆／改版）= 失敗（冷卻中不罰）
  - 403／404／非短評頁 → 該片 `retryAfter` 12 小時；超時／網路／5xx → 1 小時；全域冷卻中或閘門飽和 → 不罰該片
  - 從未成功抓過且被拒 → API 回 503／冷卻中 429，一律帶 `Retry-After`（冷卻剩餘秒數／該片罰期剩餘秒數／閘門飽和 30s）；已有本地資料則降級只回本地
- 閘門（`douban-anti-crawler.ts`，短評與推薦共用）：請求含 PoW 整段串行，下一個從上一個結束起算 1.5s＋抖動；
  任一豆瓣回應 429（含 cookie 分支、驗證流程）→ 全域冷卻 15 分鐘，期間回合成 429，排隊中的也不出網；
  佇列超過 8 個 → 直接回合成 503；每次出網 15s 超時。合成回應帶 `Retry-After` 與 `X-Douban-Gate`（調用方據此不罰該片；兩個 API 都會轉發 `Retry-After`）。
- 預熱：cron 收藏刷新結束後（獨立 try/catch），用已取得詳情的 `douban_id` 最多預熱 3 部（跳過已有資料或仍在 `retryAfter` 內的），遇拒即停；受 `EnableComments` 控制。
- 已知天花板：閘門與同片串行都是單進程記憶體（多 instance 需搬進存儲）；每片不設保留上限；後台「資料遷移」匯出不含 `dc:*`，只有整庫備份涵蓋。
- 實測（2026-09-07，肖申克 1292052）：首次 2.7–3.3s（含 PoW）→ 本地 10–20ms；豆瓣本體匿名 `start=200` 回 403（本 API 的 `start` 是本地 rank，不會 403）。
- 實測（2026-09-07，`isCommentsPage` 依據）：有評論頁（1292052 `start=0`）`#comments`=1；合法空頁（畢業短片 35632994，「看过(39)」，`start=40`）→ 200、`#comments`=1、0 則、無 `a.next`、內文「还没有人写过短评」。豆瓣改版時先查這個選擇器。

## 9. 漫畫模組：iOS 返回、載入與資訊清晰度

- 新增：`src/app/manga/loading.tsx`、`src/app/manga/detail/loading.tsx`（同時是詳情頁抓資料時的骨架）、`src/app/manga/read/loading.tsx`、`src/components/manga/MangaChapterOrderToggle.tsx`、`src/hooks/useOverlayFocus.ts`
- 修改上游：`src/app/manga/{page,detail/page,read/page,search/page,shelf/page}.tsx`、`src/components/{MangaCard,CapsuleSwitch}.tsx`、`src/components/manga/{MangaLayout,MangaHistoryCard}.tsx`、`src/lib/suwayomi.client.ts`；
  本 fork 檔案：`src/lib/{manga-reader,manga-browse-state,manga-source-groups}.ts`、`src/components/manga/{MangaSourcePicker,MangaSourceSheet,MangaSourceMultiPicker,MangaFilterGroupChips}.tsx`
- 必守（合併上游或重寫時不可退回）：
  - 捲動容器是 `body`，存／還原只讀寫 `document.body.scrollTop`。對根捲動寫非 0（`window.scrollTo(0, y)`、`documentElement.scrollTop = y`）在 iOS 27 PWA 會把到不了的位置交給原生捲動層，整頁能捲卻點不動
  - 漫畫連結一律用 `URLSearchParams` 組（`buildMangaDetailHref`／`buildMangaReadHref`）。Next 14.2 預取時 `searchParams.delete('_rsc')` 會把查詢字串重新序列化（空白 → `+`、括號 → `%28`），`encodeURIComponent` 拼的網址與點擊時的快取 key 對不上：預取全部白做、點下去要等伺服器完整回應、loading 也出不來
  - loading boundary 要放在被導覽到的那一段（`detail/`、`read/`）；只放 `app/manga/loading.tsx` 對 `/manga` → `/manga/detail` 不起作用
  - 章節順序走 `orderMangaChapters`：Suwayomi 回的清單即來源順序（舊到新）。有話數的章節逆向不超過一成就照它，特別篇（`chapterNumber -1`）與名稱尾數被誤判的話數都留在原位；真的亂序才退回話數 → `uploadDate` → id
  - 詳情章節每批 120 話、章節連結 `prefetch={false}`；閱讀器章節面板 `content-visibility:auto`
  - `getChapterPages` 的 `chapterPagesCache`：30 分鐘、64 筆、併發合併、空清單不快取、命中仍跑 `assertSourceAllowed`
  - 推荐：分頁用 `appendUniqueMangas` 去重（整頁重複就停止翻頁）；沒帶來源時 `pickDefaultMangaSourceId`（最近選過 → 熱門測試正常的一般源 → 混合源）；離開列表在 layout effect cleanup 存瀏覽狀態，還原捲動要等分類載入完成
  - `useOverlayFocus(..., { modal: true })` 只給蓋住整個畫面、portal 到 body 的層（源管理、換源 sheet）；閱讀器面板不設 inert，header 開關要保持可按
- 介面：章節預設最早在前（`moontv_manga_chapter_order`）；推荐卡片不重複來源與類型徽章，分行顯示「最新：… · 共 N 話」「看到：…」「作者：… · 狀態」；
  觸控裝置不套 hover 位移，選取類 hover 只給 `(hover:hover)`；`prefers-reduced-motion` 時停用卡片位移／縮放與未讀徽章動畫
- 載入進度：`MangaLoadingStatus`（跑動進度條＋已等待秒數，8 秒後註明來源慢）用在 `app/manga/{loading,detail/loading,read/loading}.tsx` 與閱讀器取頁面時；
  同一標籤在路由 loading 與頁面骨架交接時沿用起點，秒數不歸零。閱讀器每頁用 `MangaPageImage`，圖片載好前顯示「第 N 頁載入中」（只在目前頁附近轉圈）
- 換源 sheet：觸控裝置開啟時焦點放對話框本身、不聚焦搜尋框（會跳鍵盤擋住清單）；`(hover: hover) and (pointer: fine)` 的桌面維持直接聚焦搜尋框
- 單本頁數：只有一話的作品標「單本 · N 頁」。頁數要 Suwayomi 抓過一次頁面清單才有，
  卡片進到畫面附近時由 `useMangaChapterSummaryQueue` 打 `/api/manga/pages`（同時 2 本、後進先出、排隊上限 12）；抓過後 Suwayomi 記住，之後列表直接帶出
- 實測（2026-10-02，production build、iPhone 13 模擬、CPU 4× 降速）：點卡片到出現骨架 ~975ms → 106–121ms（網路延遲 400ms）；開始閱讀 1606ms → 115ms；
  武炼巅峰（3875 話）詳情 ready 1.9–2.6s → 0.40s、TBT 1.5–1.9s → 48–59ms、往下捲觸發的 RSC 預取 124 → 0

## 10. 站長操作紀錄（owner 專用）

- 新增：`src/components/ActivityLogger.tsx`、`src/lib/activity-log.ts`（事件型別與正規化，含 `activity-log.test.ts`）、`src/app/api/activity-log/route.ts`；
  修改上游：`src/app/layout.tsx` 在 `<TopProgressBar />` 後掛 `<ActivityLogger />`
- 目的：回報「點了沒反應」「頁面卡住」時，有實際操作序列可查，不必靠重現
- 只記錄站長（cookie `role === 'owner'`）；監聽一律 capture／passive、從不 `preventDefault`，不影響頁面行為
- 事件（每筆都有 `t` 時間、`sid` 分頁 session、`path`）：
  - `session`：UA、視窗寬高、`dpr`、`standalone`（是否以 PWA 開啟）
  - `nav`：`from` → `path`
  - `tap`：座標、`sy`（`body.scrollTop`）、`wy`（`window.scrollY`）、元素 `tag`／`name`（aria-label 或文字前 40 字）、`href`、`interactive`、`clicked`。
    按下到放開位移 ≤ 10px、≤ 800ms 才算一次 tap；`clicked: false` 表示 700ms 內 click 沒到 document（iOS 整頁點不動就是這個樣子）
  - `vis`：切到背景／回前景；`error`：前端錯誤與未處理的 Promise rejection
- 送出：每 10 秒或滿 50 筆批次 POST；切背景、關頁改用 `sendBeacon`；單次最多 100 筆，佇列上限 500
- 儲存：Kvrocks list `activity_log:<站長帳號>`，最新在前，保留 20000 筆；非 Redis 系存儲回 501，前端就停止記錄
- 讀取（owner／admin，讀的都是站長的紀錄）：`/api/activity-log?limit=500`（JSON，`limit` 最多 5000）；加 `&format=jsonl` 改為一行一筆
- 清空：`redis-cli -u "$KVROCKS_URL" DEL activity_log:<站長帳號>`。用 owner 帳號跑自動化測試後要清，以免混進真實紀錄

## 11. 漫畫源出口標示（WARP／直連）

- 新增：`src/lib/manga-source-egress.test.ts`；修改上游：`src/lib/manga.types.ts`（`MANGA_EGRESS_META_KEY`、`MangaSourceEgress`、`parseMangaSourceEgress`）、
  `src/lib/suwayomi.client.ts`（`getSourceEgressForAdmin`）；本 fork 檔案：`src/app/api/admin/manga-sources/route.ts`（GET 附 `egress`）、`src/components/manga/MangaSourceManagerPanel.tsx`（`EgressBadge`）
- 資料來源：主機上的 Suwayomi 分流（`~/github/Suwayomi-Server-docker/egress/warp_route.py`，systemd `suwayomi-warp-route.timer`）每次更新路由後，
  把每個來源的出口寫進 Suwayomi source meta `moontv.egress`（JSON：`route`、`hosts[{host, route, directMs, warpMs}]`、`warpDown`、`updatedAt`）。MoonTVPlus 只讀不寫
- 統計範圍是來源 `homeUrl` 的主站網域（含子網域）。圖片放在其他網域的 CDN 從分流只看得到主機、對應不到來源，不列入
- 面板在語言旁顯示「WARP」「直連」「混合 WARP n/m」，WARP 不通時顯示「直連（WARP 不通）」；滑鼠停留列出每個主機的路由與最近一次測速
- 只給管理員（源管理面板與下一條的 picker）：出口主機屬於基礎設施資訊，一般使用者的 `/api/manga/sources` 不帶這個欄位。讀 meta 失敗時列表照常顯示、只是沒有標示
- 推荐頁換源 picker（`src/components/manga/MangaSourcePicker.tsx` 的 `egress` prop）在延遲旁顯示「WARP」「直连」「混合」，只有管理員看得到：
  `src/app/api/manga/sources/route.ts` 依 cookie `role`（owner／admin）才讀 `getSourceEgressForAdmin`，回應的 `egress` 只含已套允許清單的來源，一般使用者不呼叫也不帶欄位；`src/app/manga/page.tsx` 轉交給 picker

## 12. 漫畫近期熱門（本日／本週／本月）

- 新增：`src/lib/manga-hot-window.ts`（`findMangaHotWindows`、`matchMangaHotWindow`）、`src/lib/manga-hot-window.test.ts`；修改：`src/app/manga/page.tsx`（推荐類型在「热门」「最新」之間插入可用的時間窗）
- Suwayomi 沒有近期熱門，改從各來源自帶的 select／sort／group_select 推：選項名稱像「日排行／本週／今天／過去 24 小時」的就是時間窗，依 filter 順序取第一個命中的控制項
- 選項本身沒有熱門字眼、且整個下拉只有時間（禁漫天堂「今天／这周／本月」）時，再配同群組（找不到就其他下拉）第一個熱門類選項（排行、熱門、人氣、點擊、瀏覽…）；「三日內／七日內」這類更新時間篩選不算
- 目前有時間窗的來源：漫画柜、MyComic、禁漫天堂、哔咔漫画、Hanime1.me、Komiic、瓜子漫画、再漫画、嗶哩漫畫
- 時間窗只存在 `filterSelections`（走 SEARCH）：跟著既有瀏覽狀態還原，不進網址；filter 恰好等於某個時間窗時 capsule 亮該時間窗，多選其他條件就改回顯示「已套用本源分类」提示

## 13. 漫畫閱讀器：雙擊放大、第一頁問上一話、即時進度

- 新增：`src/components/manga/MangaZoomViewer.tsx`；修改：`src/app/manga/read/page.tsx`、`src/app/manga/detail/page.tsx`、`src/components/manga/MangaHistoryCard.tsx`、
  `src/lib/manga-reader.ts`（`getPreviousMangaChapter`、`isMangaChapterInProgress`、`isMangaDoubleTap`、`getMangaZoomLayout`；`buildMangaReadHref` 的 `startAt: 'first' | 'last' | 'resume'`）、`src/lib/db.client.ts`（閱讀紀錄 POST 加 `keepalive`）
- 雙擊放大：圖上單擊要等 300ms 雙擊時間窗才切換控制列；雙擊在全螢幕捲動層放大 2.5 倍，點到的位置留在手指下，用原生捲動拖曳；再雙擊、關閉鈕或 Esc 縮回原位。
  不在原頁面 transform —— 直式的捲動容器是 body（見第 9 節的 iOS 根捲動問題），頁碼追蹤也不受影響。
  閱讀區與每張圖都要 `touch-action: manipulation`：關掉瀏覽器自己的雙擊縮放，而 touch-action 只算到最近的捲動容器（每頁外框、水平容器）
- 第一頁再往前：直式捲在最上面、其他模式在第一頁時，按上一頁／←／PageUp，或直式往下拉、水平往右滑超過 72px，就問要不要回上一話。
  「上一话」帶 `startPage=last` 從最後一頁接著往回看，另有「从上一话第 1 页开始」；確定是第一話就不問
- 即時進度：翻頁後 2 秒內寫入閱讀紀錄（原本 10 秒），切背景／離開時照舊立刻寫，POST 用 `keepalive` 讓 iOS 凍結頁面時也送得出去。
  詳情頁有紀錄時「继续阅读」是主按鈕、「从第一话开始」次要；章節列表中讀到一半（還沒到最後一頁）的那一話點下去續讀，其他話與讀完的照舊從第 1 頁

## 設定鍵一覽（localStorage）

| Key | 功能 | 預設 |
|---|---|---|
| `interfaceTraditionalChinese` | 繁體中文介面 | 無值時依系統語系自動判斷 |
| `crossRegionTitleSearch` | 三地片名搜尋 | `true`（未設或非 `'false'` 即開） |
| `searchTraditionalToSimplified` | 搜尋繁轉簡（上游既有，繁體介面啟用時連動開啟） | `false` |
| `moontv_manga_chapter_order` | 漫畫章節排序（詳情頁與閱讀器共用） | 無值＝最早在前；`newest` 時最新在前 |

## 上游同步流程

```bash
git fetch upstream
git merge --no-ff upstream/main   # 保留既有 v223/v224 merge boundary；rerere 已啟用
pnpm typecheck && pnpm test -- src/lib/title-alias.test.ts src/lib/search-title-match.test.ts src/components/DoubanSelector.test.ts src/lib/tmdb.client.test.ts src/lib/netflix-top10.test.ts src/lib/playback-auto-next.test.ts --runInBand
```


## 本機開發：用 host Node 取代每次 docker rebuild

`docker compose up -d --build moontvplus-core` 約需 190 秒。單純改 app 程式碼
不需要走這條 —— 本專案的容器就只是 `node:24-alpine` + `node start.js`（見
`Dockerfile`），沒有系統依賴，所以 app 本體可以直接在 host 上跑 `pnpm dev`
（HMR，存檔即生效）。

需要留在容器裡的只有兩個非 Node 的 daemon：**Suwayomi**（JVM）與
**Kvrocks**（C++/RocksDB）。

### 一次性設定

1. `docker-compose.yml` 已把 kvrocks 綁到 `127.0.0.1:6666`（只 loopback）。
2. host 需要能解析 compose 的服務名，加到 `/etc/hosts`：

   ```
   127.0.0.1 suwayomi moontvplus-kvrocks
   ```

   **為什麼需要**：admin 設定裡存的 `SuwayomiConfig.ServerURL` 是
   `http://suwayomi:4567`（容器內名稱），而 `resolveSuwayomiConfig()` 讓
   admin 設定**優先於環境變數**，所以光覆寫 `SUWAYOMI_URL` 無效。
   長期方案是把 admin 設定改成 `127.0.0.1:4567`；hosts 只是免改設定的權宜做法。
   少了這步，`/api/manga/*` 會回 500 `fetch failed`。

### 啟動

```bash
docker compose up -d moontvplus-kvrocks          # 只要 DB
PORT=3200 OFFLINE_DOWNLOAD_DIR=/tmp/moontv-dl pnpm dev
```

dev server 在 `:3200`，與 `:3100` 的 production 容器共用同一份 kvrocks 與
Suwayomi 資料，兩邊可並存。

### 仍然必須跑 docker build 的情況

| 情況 | 原因 |
|---|---|
| 改 `next.config.js` | 設定只在 build 時生效 |
| 驗證 service worker / PWA | `next.config.js` 在 `isDevelopment` 時直接 `return nextConfig`，**完全跳過 `withPWA`**。SW、`runtimeCaching`、`/api/` 的 `NetworkOnly` 規則在 dev 模式下不存在，只能用 production build 驗 |
| 依賴變更（`package.json` / lockfile） | 需重建 image layer |
| 發佈前最終驗證 | 確認 image 與 host 行為對等 |

其餘（API 授權與 403 邊界、UI 行為、GraphQL 互動）在 dev 模式驗證與
production 等價。
