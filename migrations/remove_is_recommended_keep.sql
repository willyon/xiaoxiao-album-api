-- 迁移脚本：删除 cleanup_group_members 表中的 is_recommended_keep 字段
-- 执行方式：sqlite3 database.db < remove_is_recommended_keep.sql
-- 
-- 迁移步骤：
-- 1. 备份数据库（建议先手动备份）
-- 2. 创建新表 cleanup_group_members_new（不包含 is_recommended_keep）
-- 3. 迁移数据（从旧表到新表，排除 is_recommended_keep）
-- 4. 删除旧表 cleanup_group_members
-- 5. 重命名新表 cleanup_group_members_new 为 cleanup_group_members
-- 6. 重新创建索引

BEGIN TRANSACTION;

-- 步骤1：创建新表 cleanup_group_members_new（不包含 is_recommended_keep）
CREATE TABLE cleanup_group_members_new (
  group_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  rank_score REAL,
  similarity REAL,
  aesthetic_score REAL,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  PRIMARY KEY (group_id, image_id),
  FOREIGN KEY (group_id) REFERENCES cleanup_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- 步骤2：迁移数据（从旧表到新表，排除 is_recommended_keep）
INSERT INTO cleanup_group_members_new (
  group_id,
  image_id,
  rank_score,
  similarity,
  aesthetic_score,
  created_at,
  updated_at
)
SELECT 
  group_id,
  image_id,
  rank_score,
  similarity,
  aesthetic_score,
  created_at,
  updated_at
FROM cleanup_group_members;

-- 步骤3：删除旧表
DROP TABLE cleanup_group_members;

-- 步骤4：重命名新表
ALTER TABLE cleanup_group_members_new RENAME TO cleanup_group_members;

-- 步骤5：重新创建索引
CREATE INDEX IF NOT EXISTS idx_cleanup_members_group_rank
ON cleanup_group_members(group_id, rank_score DESC);

CREATE INDEX IF NOT EXISTS idx_cleanup_members_image
ON cleanup_group_members(image_id);

COMMIT;

-- 验证迁移结果
-- 检查表结构（应该不包含 is_recommended_keep）
-- SELECT sql FROM sqlite_master WHERE type='table' AND name='cleanup_group_members';

