# MoonTVPlus 本地自訂功能維護清單

最後更新：2026-08-27

**權威清單是 repo 根目錄的 `CUSTOM_FEATURES.md`。** 合併上游時以那份衝突熱檔表為準，不要只看本檔——本檔早期只記 iOS PWA，漏了繁中／別名／Netflix 等客製。

PWA 五檔與繁中同等優先，細節已收進 `CUSTOM_FEATURES.md` §6：

- `src/lib/ios-pwa.ts`
- `src/components/PwaSafariPrompt.tsx`
- `src/app/play/page.tsx`
- `src/app/web-live/page.tsx`
- `src/app/globals.css`

## 同步方式

用 `git merge --no-ff upstream/main`（保留 v223/v224 merge boundary）。不要 rebase 已推送的 `main`。

```bash
git fetch --all --prune
git switch main
git status --short
git branch backup/moontvplus-local-$(date +%Y%m%d-%H%M)
git merge --no-ff upstream/main
```

驗證指令見 `CUSTOM_FEATURES.md`「上游同步流程」。本機 Docker smoke：

```bash
docker compose up -d --build moontvplus-core
curl -sS -o /tmp/moontvplus-smoke.html -w '%{http_code}\n' --max-time 15 http://127.0.0.1:3100/
```

預期 `307` 導向 `/login?redirect=%2F`。
