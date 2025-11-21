-- ============================================
-- 优化 deleted_at 索引：从普通索引改为部分索引
-- ============================================
-- 说明：
-- 1. 删除旧的普通索引 idx_images_user_deleted
-- 2. 创建新的部分索引，只索引未删除的记录（deleted_at IS NULL）
-- 3. 这样可以显著提升查询性能，因为几乎所有查询都过滤 deleted_at IS NULL
--
-- 执行方式：
-- sqlite3 your_database.db < optimize_deleted_at_index.sql
-- 或者
-- sqlite3 your_database.db
-- .read optimize_deleted_at_index.sql
-- ============================================

BEGIN TRANSACTION;

-- 步骤1：删除旧的普通索引
DROP INDEX IF EXISTS idx_images_user_deleted;

-- 步骤2：创建新的部分索引（只索引未删除的记录）
CREATE INDEX IF NOT EXISTS idx_images_user_deleted
ON images(user_id, deleted_at)
WHERE deleted_at IS NULL;

COMMIT;

-- ============================================
-- 验证索引创建结果
-- ============================================
-- 执行以下命令验证索引是否创建成功：
-- SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_images_user_deleted';
--
-- 预期结果应该显示：
-- name: idx_images_user_deleted
-- sql: CREATE INDEX idx_images_user_deleted ON images(user_id, deleted_at) WHERE deleted_at IS NULL
-- ============================================

