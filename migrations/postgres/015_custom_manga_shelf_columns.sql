-- ============================================
-- 本 fork 客製：漫畫書架收藏與更新時間欄位（feat(manga) d8def654）
-- 新庫由 006 建表時帶上；這裡補給 006 已執行過的舊庫。
-- 上游 v227 拿掉 PostgresStorage 啟動時的 ensureMangaShelfColumns，改由 migration 補欄位（見 014）。
-- ============================================

ALTER TABLE manga_shelf ADD COLUMN IF NOT EXISTS update_time BIGINT;
ALTER TABLE manga_shelf ADD COLUMN IF NOT EXISTS favorite INTEGER;
