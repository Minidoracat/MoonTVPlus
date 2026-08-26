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

