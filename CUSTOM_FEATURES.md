# 客製功能清單

> 本 fork 的客製功能總覽。每節列出該功能「新增的檔案」與「修改的上游檔案及區塊」，
> 供未來合併上游（`git merge upstream/main`）解衝突時對照：衝突發生在下列區塊時，
> 原則是 **保留本清單描述的客製區塊 + 接受上游的其他改動**。
>
> 所有客製 commit 統一使用 `feat(custom):` 前綴，可用 `git log --grep="(custom)"` 列出。

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
- `src/app/api/search/route.ts` — `alias=1` 參數、`queriesPromise` 並行解析、回應加 `aliases` 欄位、改呼叫 `searchFromApiWithQueries`
- `src/app/api/search/ws/route.ts` — 同上 + SSE `aliases` 事件（在 start 事件後、站點搜尋前發送）
- `src/app/search/page.tsx` — 請求帶 `&alias=1`、`searchAliases` state/ref、
  `titleContainsQuery` 精確搜尋過濾接受別名命中、`SearchCachePayload` 加選用 `aliases` 欄位
- `src/components/UserMenu.tsx` — 通用設置區「三地片名搜索」開關（state / 載入 / handler / UI / 重置）

## 設定鍵一覽（localStorage）

| Key | 功能 | 預設 |
|---|---|---|
| `interfaceTraditionalChinese` | 繁體中文介面 | 無值時依系統語系自動判斷 |
| `crossRegionTitleSearch` | 三地片名搜尋 | `false` |
| `searchTraditionalToSimplified` | 搜尋繁轉簡（上游既有，繁體介面啟用時連動開啟） | `false` |

## 上游同步流程

```bash
git fetch upstream
git merge upstream/main   # rerere 已啟用，重複衝突會自動套用先前解法
pnpm typecheck && pnpm lint
```
