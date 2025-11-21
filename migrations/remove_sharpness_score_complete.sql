-- 完整迁移脚本：删除 sharpness_score 字段
-- 注意：SQLite 不支持直接删除列，需要重建表

-- ============================================
-- 步骤 1：备份数据库（建议先手动备份）
-- ============================================
-- sqlite3 database.db ".backup database_backup.db"

-- ============================================
-- 步骤 2：删除相关索引
-- ============================================
DROP INDEX IF EXISTS idx_images_user_sharpness;

-- ============================================
-- 步骤 3：重建 cleanup_group_members 表（删除 sharpness_score）
-- ============================================

-- 3.1 创建新表（不包含 sharpness_score）
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

-- 3.2 复制数据（排除 sharpness_score）
INSERT INTO cleanup_group_members_new 
  (group_id, image_id, rank_score, is_recommended_keep, similarity, aesthetic_score, created_at, updated_at)
SELECT 
  group_id, image_id, rank_score, is_recommended_keep, similarity, aesthetic_score, created_at, updated_at
FROM cleanup_group_members;

-- 3.3 删除旧表
DROP TABLE cleanup_group_members;

-- 3.4 重命名新表
ALTER TABLE cleanup_group_members_new RENAME TO cleanup_group_members;

-- 3.5 重建索引
CREATE INDEX IF NOT EXISTS idx_cleanup_members_group_rank
ON cleanup_group_members(group_id, rank_score DESC);

-- ============================================
-- 步骤 4：重建 images 表（删除 sharpness_score）
-- ============================================
-- 注意：由于 images 表结构复杂，需要完整重建

-- 4.1 创建新表（不包含 sharpness_score）
CREATE TABLE images_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  original_storage_key TEXT,
  high_res_storage_key TEXT,
  thumbnail_storage_key TEXT,
  image_created_at INTEGER,
  image_hash TEXT,
  image_phash TEXT,
  image_dhash TEXT,
  year_key TEXT DEFAULT 'unknown',
  month_key TEXT DEFAULT 'unknown',
  date_key TEXT DEFAULT 'unknown',
  day_key TEXT DEFAULT 'unknown',
  gps_latitude REAL,
  gps_longitude REAL,
  gps_altitude REAL,
  gps_location TEXT,
  country TEXT,
  city TEXT,
  width_px INTEGER,
  height_px INTEGER,
  aspect_ratio REAL,
  raw_orientation INTEGER,
  layout_type TEXT,
  hd_width_px INTEGER,
  hd_height_px INTEGER,
  storage_type TEXT,
  file_size_bytes INTEGER,
  mime TEXT,
  color_theme TEXT DEFAULT 'neutral',
  created_at INTEGER,
  deleted_at INTEGER,
  alt_text TEXT DEFAULT NULL,
  ocr_text TEXT DEFAULT NULL,
  keywords TEXT DEFAULT NULL,
  scene_tags TEXT DEFAULT NULL,
  object_tags TEXT DEFAULT NULL,
  face_count INTEGER DEFAULT NULL,
  person_count INTEGER DEFAULT NULL,
  expression_tags TEXT DEFAULT NULL,
  age_tags TEXT DEFAULT NULL,
  gender_tags TEXT DEFAULT NULL,
  has_young INTEGER DEFAULT NULL,
  has_adult INTEGER DEFAULT NULL,
  primary_face_quality REAL DEFAULT NULL,
  primary_expression_confidence REAL DEFAULT NULL,
  analysis_version TEXT DEFAULT '1.0',
  aesthetic_score REAL DEFAULT NULL,
  is_blurry INTEGER DEFAULT NULL,
  blurry_probability REAL DEFAULT NULL,
  UNIQUE (user_id, image_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4.2 复制数据（排除 sharpness_score）
INSERT INTO images_new 
  (id, user_id, original_storage_key, high_res_storage_key, thumbnail_storage_key, image_created_at, image_hash, image_phash, image_dhash, year_key, month_key, date_key, day_key, gps_latitude, gps_longitude, gps_altitude, gps_location, country, city, width_px, height_px, aspect_ratio, raw_orientation, layout_type, hd_width_px, hd_height_px, storage_type, file_size_bytes, mime, color_theme, created_at, deleted_at, alt_text, ocr_text, keywords, scene_tags, object_tags, face_count, person_count, expression_tags, age_tags, gender_tags, has_young, has_adult, primary_face_quality, primary_expression_confidence, analysis_version, aesthetic_score, is_blurry, blurry_probability)
SELECT 
  id, user_id, original_storage_key, high_res_storage_key, thumbnail_storage_key, image_created_at, image_hash, image_phash, image_dhash, year_key, month_key, date_key, day_key, gps_latitude, gps_longitude, gps_altitude, gps_location, country, city, width_px, height_px, aspect_ratio, raw_orientation, layout_type, hd_width_px, hd_height_px, storage_type, file_size_bytes, mime, color_theme, created_at, deleted_at, alt_text, ocr_text, keywords, scene_tags, object_tags, face_count, person_count, expression_tags, age_tags, gender_tags, has_young, has_adult, primary_face_quality, primary_expression_confidence, analysis_version, aesthetic_score, is_blurry, blurry_probability
FROM images;

-- 4.3 删除旧表
DROP TABLE images;

-- 4.4 重命名新表
ALTER TABLE images_new RENAME TO images;

-- 4.5 重建所有索引（从 initTableModel.js 中提取）
CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id);
CREATE INDEX IF NOT EXISTS idx_images_hash ON images(image_hash);
CREATE INDEX IF NOT EXISTS idx_images_user_hash ON images(user_id, image_hash);
CREATE INDEX IF NOT EXISTS idx_images_user_creation_desc ON images(user_id, image_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_year_creation ON images(user_id, year_key, image_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_month_creation ON images(user_id, month_key, image_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_storage_creation ON images(user_id, storage_type, image_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_year ON images(user_id, year_key);
CREATE INDEX IF NOT EXISTS idx_images_user_month ON images(user_id, month_key);
CREATE INDEX IF NOT EXISTS idx_images_user_date ON images(user_id, date_key);
CREATE INDEX IF NOT EXISTS idx_images_user_day ON images(user_id, day_key);
CREATE INDEX IF NOT EXISTS idx_images_user_location ON images(user_id, country, city);
CREATE INDEX IF NOT EXISTS idx_images_user_gps ON images(user_id, gps_latitude, gps_longitude);
CREATE INDEX IF NOT EXISTS idx_images_user_layout ON images(user_id, layout_type);
CREATE INDEX IF NOT EXISTS idx_images_user_color ON images(user_id, color_theme);
CREATE INDEX IF NOT EXISTS idx_images_user_face_count ON images(user_id, face_count);
CREATE INDEX IF NOT EXISTS idx_images_user_person_count ON images(user_id, person_count);
CREATE INDEX IF NOT EXISTS idx_images_user_aesthetic ON images(user_id, aesthetic_score);
CREATE INDEX IF NOT EXISTS idx_images_user_is_blurry ON images(user_id, is_blurry);
CREATE INDEX IF NOT EXISTS idx_images_phash ON images(image_phash);
CREATE INDEX IF NOT EXISTS idx_images_dhash ON images(image_dhash);

-- ============================================
-- 完成
-- ============================================
-- 迁移完成！sharpness_score 字段已从两个表中删除。

