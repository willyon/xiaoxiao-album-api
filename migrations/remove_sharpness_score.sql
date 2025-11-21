-- 删除 sharpness_score 字段
-- 注意：SQLite 不支持直接删除列（ALTER TABLE DROP COLUMN），需要使用重建表的方式

-- 1. 删除相关索引
DROP INDEX IF EXISTS idx_images_user_sharpness;

-- 2. 重建 cleanup_group_members 表（删除 sharpness_score 字段）
-- 注意：由于 SQLite 的限制，需要手动执行以下步骤：
-- 
-- 步骤 1：创建新表（不包含 sharpness_score）
CREATE TABLE cleanup_group_members_new (
  group_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  rank_score REAL,
  is_recommended_keep INTEGER DEFAULT 0,
  similarity REAL,
  aesthetic_score REAL,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  PRIMARY KEY (group_id, image_id),
  FOREIGN KEY (group_id) REFERENCES cleanup_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- 步骤 2：复制数据（排除 sharpness_score）
INSERT INTO cleanup_group_members_new 
  (group_id, image_id, rank_score, is_recommended_keep, similarity, aesthetic_score, created_at, updated_at)
SELECT 
  group_id, image_id, rank_score, is_recommended_keep, similarity, aesthetic_score, created_at, updated_at
FROM cleanup_group_members;

-- 步骤 3：删除旧表
DROP TABLE cleanup_group_members;

-- 步骤 4：重命名新表
ALTER TABLE cleanup_group_members_new RENAME TO cleanup_group_members;

-- 步骤 5：重建索引
CREATE INDEX IF NOT EXISTS idx_cleanup_members_group_rank
ON cleanup_group_members(group_id, rank_score DESC);

-- 3. 重建 images 表（删除 sharpness_score 字段）
-- 注意：由于 images 表结构复杂，建议使用数据库管理工具或编写专门的迁移脚本
-- 以下是基本步骤（需要根据实际表结构调整）：
--
-- CREATE TABLE images_new (... 不包含 sharpness_score ...);
-- INSERT INTO images_new SELECT ... 排除 sharpness_score ... FROM images;
-- DROP TABLE images;
-- ALTER TABLE images_new RENAME TO images;
-- 重建所有索引...
