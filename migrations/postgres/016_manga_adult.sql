-- ============================================
-- 本 fork 客製：漫畫成人源授權與安全模式欄位
-- 版本: 016
-- 創建時間: 2026-10-31
-- ============================================

-- 管理員授權可見成人漫畫源（0 = 未授權，預設拒絕）
ALTER TABLE users ADD COLUMN IF NOT EXISTS manga_adult INTEGER DEFAULT 0;

-- 使用者的漫畫安全模式（1 = 隱藏成人源）
ALTER TABLE users ADD COLUMN IF NOT EXISTS manga_safe_mode INTEGER DEFAULT 0;

-- 添加註釋
COMMENT ON COLUMN users.manga_adult IS '管理員授權可見成人漫畫源';
COMMENT ON COLUMN users.manga_safe_mode IS '漫畫安全模式，開啟時隱藏成人源';
