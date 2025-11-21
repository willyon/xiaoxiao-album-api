-- 迁移脚本：删除 is_blurry 和 blurry_probability，添加 sharpness_score
-- 执行方式：sqlite3 database.db < migrate_sharpness_score.sql
-- 
-- 迁移步骤：
-- 1. 备份数据库（使用 backup_before_sharpness_migration.sql）
-- 2. 创建新表 images_new（不包含 is_blurry 和 blurry_probability，包含 sharpness_score）
-- 3. 迁移数据（从旧表到新表）
-- 4. 删除旧表 images
-- 5. 重命名新表 images_new 为 images
-- 6. 重新创建索引和约束

BEGIN TRANSACTION;

-- 步骤1：创建新表 images_new（删除 is_blurry 和 blurry_probability，添加 sharpness_score）
CREATE TABLE "images_new" (
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
  sharpness_score REAL DEFAULT NULL,
  UNIQUE (user_id, image_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 步骤2：迁移数据（从旧表到新表，排除 is_blurry 和 blurry_probability）
INSERT INTO images_new (
  id,
  user_id,
  original_storage_key,
  high_res_storage_key,
  thumbnail_storage_key,
  image_created_at,
  image_hash,
  image_phash,
  image_dhash,
  year_key,
  month_key,
  date_key,
  day_key,
  gps_latitude,
  gps_longitude,
  gps_altitude,
  gps_location,
  country,
  city,
  width_px,
  height_px,
  aspect_ratio,
  raw_orientation,
  layout_type,
  hd_width_px,
  hd_height_px,
  storage_type,
  file_size_bytes,
  mime,
  color_theme,
  created_at,
  deleted_at,
  alt_text,
  ocr_text,
  keywords,
  scene_tags,
  object_tags,
  face_count,
  person_count,
  expression_tags,
  age_tags,
  gender_tags,
  has_young,
  has_adult,
  primary_face_quality,
  primary_expression_confidence,
  analysis_version,
  aesthetic_score,
  sharpness_score
)
SELECT
  id,
  user_id,
  original_storage_key,
  high_res_storage_key,
  thumbnail_storage_key,
  image_created_at,
  image_hash,
  image_phash,
  image_dhash,
  year_key,
  month_key,
  date_key,
  day_key,
  gps_latitude,
  gps_longitude,
  gps_altitude,
  gps_location,
  country,
  city,
  width_px,
  height_px,
  aspect_ratio,
  raw_orientation,
  layout_type,
  hd_width_px,
  hd_height_px,
  storage_type,
  file_size_bytes,
  mime,
  color_theme,
  created_at,
  deleted_at,
  alt_text,
  ocr_text,
  keywords,
  scene_tags,
  object_tags,
  face_count,
  person_count,
  expression_tags,
  age_tags,
  gender_tags,
  has_young,
  has_adult,
  primary_face_quality,
  primary_expression_confidence,
  analysis_version,
  aesthetic_score,
  NULL as sharpness_score  -- 新字段初始化为 NULL
FROM images;

-- 步骤3：删除旧索引（如果存在）
-- 注意：删除表时会自动删除所有相关索引，这里先删除以避免冲突
DROP INDEX IF EXISTS idx_images_user_is_blurry;

-- 步骤4：删除旧表（删除表时会自动删除所有相关索引）
DROP TABLE images;

-- 步骤5：重命名新表
ALTER TABLE images_new RENAME TO images;

-- 步骤6：重新创建必要的索引
-- 注意：SQLite 会自动创建 UNIQUE 约束的索引（sqlite_autoindex_images_1）
-- 其他索引需要手动重新创建（这些索引基于其他字段，不受字段删除影响）
-- 以下是 images 表的常用索引，根据实际需要可以调整

-- 哈希相关索引（用于重复图检测）
CREATE INDEX IF NOT EXISTS idx_images_hash ON images(image_hash);
CREATE INDEX IF NOT EXISTS idx_images_phash ON images(image_phash);
CREATE INDEX IF NOT EXISTS idx_images_dhash ON images(image_dhash);
CREATE INDEX IF NOT EXISTS idx_images_user_hash ON images(user_id, image_hash);

-- 用户相关索引
CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id);
CREATE INDEX IF NOT EXISTS idx_images_user_aesthetic ON images(user_id, aesthetic_score);
CREATE INDEX IF NOT EXISTS idx_images_user_color ON images(user_id, color_theme);

-- 时间相关索引
CREATE INDEX IF NOT EXISTS idx_images_user_creation_desc ON images(user_id, image_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_date ON images(user_id, date_key);
CREATE INDEX IF NOT EXISTS idx_images_user_day ON images(user_id, day_key);
CREATE INDEX IF NOT EXISTS idx_images_user_month ON images(user_id, month_key);
CREATE INDEX IF NOT EXISTS idx_images_user_year ON images(user_id, year_key);
CREATE INDEX IF NOT EXISTS idx_images_user_month_creation ON images(user_id, month_key, image_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_year_creation ON images(user_id, year_key, image_created_at DESC, id DESC);

-- 位置相关索引
CREATE INDEX IF NOT EXISTS idx_images_user_gps ON images(user_id, gps_latitude, gps_longitude);
CREATE INDEX IF NOT EXISTS idx_images_user_location ON images(user_id, country, city);

-- 其他索引
CREATE INDEX IF NOT EXISTS idx_images_user_face_count ON images(user_id, face_count);
CREATE INDEX IF NOT EXISTS idx_images_user_person_count ON images(user_id, person_count);
CREATE INDEX IF NOT EXISTS idx_images_user_layout ON images(user_id, layout_type);
CREATE INDEX IF NOT EXISTS idx_images_user_storage_creation ON images(user_id, storage_type, image_created_at DESC, id DESC);

-- 注意：idx_images_user_is_blurry 索引已删除，不再需要

COMMIT;

-- 验证迁移结果
-- SELECT COUNT(*) FROM images;
-- PRAGMA table_info(images);
-- SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='images';

