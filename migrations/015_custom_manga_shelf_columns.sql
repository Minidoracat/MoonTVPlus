-- ============================================
-- 本 fork 客製：漫畫書架收藏與更新時間欄位（feat(manga) d8def654）
-- 新庫由 006 建表時帶上；這裡補給 006 已執行過的舊庫。
-- 上游 v227 拿掉 D1Storage 啟動時的 ensureMangaShelfColumns，改由 migration 補欄位（見 014）。
-- 獨立成檔：D1 的 wrangler d1 execute 遇到 duplicate column 會整檔失敗，不跟 014 綁在一起。
-- ============================================

ALTER TABLE manga_shelf ADD COLUMN update_time INTEGER;
ALTER TABLE manga_shelf ADD COLUMN favorite INTEGER;
