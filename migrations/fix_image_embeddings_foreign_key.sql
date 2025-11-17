-- 修复 image_embeddings 表的外键约束
-- 将错误的表名 images_old_1763335699604 改为 images

-- 1. 创建临时表保存数据
CREATE TABLE image_embeddings_temp AS SELECT * FROM image_embeddings;

-- 2. 删除原表
DROP TABLE image_embeddings;

-- 3. 重新创建表，使用正确的表名
CREATE TABLE image_embeddings (
  image_id INTEGER PRIMARY KEY,
  vector BLOB NOT NULL,
  model_id TEXT NOT NULL,
  created_at INTEGER,
  FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- 4. 恢复数据
INSERT INTO image_embeddings SELECT * FROM image_embeddings_temp;

-- 5. 删除临时表
DROP TABLE image_embeddings_temp;

-- 6. 重新创建索引（如果不存在）
CREATE INDEX IF NOT EXISTS idx_image_embeddings_model
ON image_embeddings(model_id);

