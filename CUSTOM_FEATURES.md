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
| `src/app/layout.tsx` | `<TraditionalChineseProvider />` |
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

## 1. 全站繁體中文介面

簡體 → 台灣正體（OpenCC `cn→twp`，含台灣用語轉換）的全站即時轉換，
涵蓋靜態 UI 與動態內容（豆瓣資料、搜尋結果、彈窗等）。未手動設定時依瀏覽器
系統語系（zh-TW / zh-HK / zh-MO / zh-Hant）自動啟用；手動設定永遠優先。

**新增檔案（零衝突風險）**
- `src/lib/opencc-client.ts` — 共用 OpenCC 轉換器單例
- `src/components/TraditionalChineseProvider.tsx` — DOM 轉換核心（TreeWalker 初掃 + MutationObserver 持續轉換）、語系偵測、設定讀寫 helper

**修改的上游檔案**
- `src/app/layout.tsx` — import + `<TraditionalChineseProvider />` 掛載（2 行，位於 `<TokenRefreshManager />` 之後）

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

## 設定鍵一覽（localStorage）

| Key | 功能 | 預設 |
|---|---|---|
| `interfaceTraditionalChinese` | 繁體中文介面 | 無值時依系統語系自動判斷 |
| `crossRegionTitleSearch` | 三地片名搜尋 | `true`（未設或非 `'false'` 即開） |
| `searchTraditionalToSimplified` | 搜尋繁轉簡（上游既有，繁體介面啟用時連動開啟） | `false` |

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
