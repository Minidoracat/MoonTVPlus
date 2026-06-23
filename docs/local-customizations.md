# MoonTVPlus 本地自訂功能維護清單

最後更新：2026-06-24

這份文件記錄本 fork 相對於 upstream `mtvpls/MoonTVPlus` 需要保留的本地功能。未來同步 upstream 前後，請用這份清單確認自訂功能沒有被覆蓋或回退。

## 目前本地自訂功能

### 1. iOS PWA 播放器控制列與 PiP fallback

- 功能 commit：`3b8509cc Improve iOS PWA player controls`
- 目的：
  - iOS Safari 網頁模式可正常使用 Picture-in-Picture。
  - iOS 加入主畫面的 PWA 模式目前不支援 programmatic PiP；避免顯示會觸發錯誤的 PiP 入口。
  - PWA 模式提供使用者「用 Safari 開啟」、「分享」、「複製連結」fallback。
  - 修正 PWA / mobile 控制列 safe-area，避免右下角全螢幕按鈕被圓角或螢幕邊緣擋住。

- 主要檔案：
  - `src/lib/ios-pwa.ts`
  - `src/components/PwaSafariPrompt.tsx`
  - `src/app/play/page.tsx`
  - `src/app/web-live/page.tsx`
  - `src/app/globals.css`

- 更新 upstream 後必查：
  - `/play` 在 Safari 網頁模式仍顯示並可使用 PiP。
  - `/play` 在 iOS PWA 模式不顯示會報錯的 PiP 按鈕，且顯示 Safari fallback 提示。
  - `/web-live` 同樣套用 PWA fallback。
  - 手機 PWA 右下角全螢幕按鈕仍可點擊，沒有被 safe-area / 圓角遮住。

## 建議 upstream 同步流程

### 1. 更新前確認本地狀態

```bash
git fetch --all --prune
git switch main
git status --short
git log --oneline upstream/main..main
git diff --stat upstream/main..main
```

如果 working tree 不乾淨，先 commit 或 stash，不要直接 rebase / merge。

### 2. 建立安全備份 branch

```bash
git branch backup/moontvplus-local-$(date +%Y%m%d-%H%M)
```

### 3. 套用 upstream 更新

優先使用 rebase，讓本地自訂 commit 保持在 upstream 最新版本之上：

```bash
git rebase upstream/main
```

如果這個 branch 已經多人共用，或不想改寫歷史，改用 merge：

```bash
git merge upstream/main
```

### 4. 解 conflict 時的重點

若 conflict 發生在下列檔案，優先保留本地 PWA / PiP / safe-area 邏輯，再人工整合 upstream 新變更：

- `src/app/play/page.tsx`
- `src/app/web-live/page.tsx`
- `src/app/globals.css`
- `src/components/PwaSafariPrompt.tsx`
- `src/lib/ios-pwa.ts`

建議開啟 Git conflict 記憶，減少下次重複解同類 conflict：

```bash
git config rerere.enabled true
```

### 5. 同步後驗證

```bash
pnpm typecheck
pnpm exec eslint --quiet src/app/play/page.tsx src/app/web-live/page.tsx src/components/PwaSafariPrompt.tsx src/lib/ios-pwa.ts

docker compose up -d --build moontvplus-core
docker compose ps
curl -sS -o /tmp/moontvplus-smoke.html -w '%{http_code}\n' --max-time 15 http://127.0.0.1:3100/
```

預期 smoke check 可回 `307` 並導向登入頁，例如 `/login?redirect=%2F`。

## 快速回復方式

若 upstream 更新後發現本地功能遺失，可先找回本地功能 commit：

```bash
git log --oneline --all --grep='Improve iOS PWA player controls'
```

需要時可 cherry-pick 回來：

```bash
git cherry-pick 3b8509cc
```

若 cherry-pick 有 conflict，依本文件「解 conflict 時的重點」保留本地功能並重新跑驗證。
