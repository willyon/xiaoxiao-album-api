-- 综合修复脚本：修复所有表的外键约束
-- 将错误的表名 images_old_1763335699604 改为 images
-- 
-- 此脚本修复以下表：
-- 1. cleanup_group_members
-- 2. cleanup_groups
-- 3. image_embeddings
-- 4. face_embeddings

-- ==================== 1. 修复 cleanup_group_members 表 ====================
DROP TABLE IF EXISTS cleanup_group_members;

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

-- ==================== 2. 修复 cleanup_groups 表 ====================
CREATE TABLE cleanup_groups_temp AS SELECT * FROM cleanup_groups;
DROP TABLE cleanup_groups;

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

INSERT INTO cleanup_groups SELECT * FROM cleanup_groups_temp;
DROP TABLE cleanup_groups_temp;

-- ==================== 3. 修复 image_embeddings 表 ====================
CREATE TABLE image_embeddings_temp AS SELECT * FROM image_embeddings;
DROP TABLE image_embeddings;

CREATE TABLE image_embeddings (
  image_id INTEGER PRIMARY KEY,
  vector BLOB NOT NULL,
  model_id TEXT NOT NULL,
  created_at INTEGER,
  FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);

INSERT INTO image_embeddings SELECT * FROM image_embeddings_temp;
DROP TABLE image_embeddings_temp;

CREATE INDEX IF NOT EXISTS idx_image_embeddings_model
ON image_embeddings(model_id);

-- ==================== 4. 修复 face_embeddings 表 ====================
CREATE TABLE face_embeddings_temp AS SELECT * FROM face_embeddings;
DROP TABLE face_embeddings;

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

INSERT INTO face_embeddings SELECT * FROM face_embeddings_temp;
DROP TABLE face_embeddings_temp;

CREATE INDEX IF NOT EXISTS idx_face_embeddings_image_id
ON face_embeddings(image_id);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_age
ON face_embeddings(age);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_gender
ON face_embeddings(gender);

CREATE INDEX IF NOT EXISTS idx_face_embeddings_expression
ON face_embeddings(expression);

