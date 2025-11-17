-- 修复 cleanup_group_members 和 cleanup_groups 表的外键约束
-- 将错误的表名 images_old_1763335699604 改为 images

-- 1. 删除 cleanup_group_members 表（会级联删除数据，但成员表本来就是空的）
DROP TABLE IF EXISTS cleanup_group_members;

-- 2. 重新创建 cleanup_group_members 表，使用正确的表名
CREATE TABLE cleanup_group_members (
  group_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  rank_score REAL,
  is_recommended_keep INTEGER DEFAULT 0,
  similarity REAL,
  aesthetic_score REAL,
  sharpness_score REAL,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  PRIMARY KEY (group_id, image_id),
  FOREIGN KEY (group_id) REFERENCES cleanup_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- 3. 修复 cleanup_groups 表的外键约束
-- 注意：SQLite 不支持直接修改外键约束，需要重建表
-- 但为了安全，我们先检查是否有数据需要保留

-- 创建临时表保存数据
CREATE TABLE cleanup_groups_temp AS SELECT * FROM cleanup_groups;

-- 删除原表
DROP TABLE cleanup_groups;

-- 重新创建表，使用正确的表名
CREATE TABLE cleanup_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  group_type TEXT NOT NULL,
  primary_image_id INTEGER,
  member_count INTEGER DEFAULT 0,
  total_size_bytes INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (primary_image_id) REFERENCES images(id) ON DELETE SET NULL
);

-- 恢复数据
INSERT INTO cleanup_groups SELECT * FROM cleanup_groups_temp;

-- 删除临时表
DROP TABLE cleanup_groups_temp;

