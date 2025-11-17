-- 修复 face_embeddings 和 face_clusters 表的外键约束
-- 将错误的表名 images_old_1763335699604 改为 images

-- ==================== 修复 face_embeddings 表 ====================
-- 1. 创建临时表保存数据
CREATE TABLE face_embeddings_temp AS SELECT * FROM face_embeddings;

-- 2. 删除原表
DROP TABLE face_embeddings;

-- 3. 重新创建表，使用正确的表名
CREATE TABLE face_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  face_index INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  age INTEGER,
  gender TEXT,
  expression TEXT,
  confidence REAL,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
  UNIQUE (image_id, face_index)
);

-- 4. 恢复数据
INSERT INTO face_embeddings SELECT * FROM face_embeddings_temp;

-- 5. 删除临时表
DROP TABLE face_embeddings_temp;

-- 6. 重新创建索引
CREATE INDEX IF NOT EXISTS idx_face_embeddings_image_id
ON face_embeddings(image_id);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_age
ON face_embeddings(age);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_gender
ON face_embeddings(gender);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_expression
ON face_embeddings(expression);

-- ==================== 修复 face_clusters 表 ====================
-- 注意：face_clusters 表可能没有直接引用 images 表，但检查一下
-- 如果 face_clusters 表的外键只引用 face_embeddings，则不需要修复

