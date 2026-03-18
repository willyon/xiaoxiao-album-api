/*
 * 一次性迁移：从 images 表移除 has_young、has_adult 列及 idx_images_user_age_flags 索引
 * 新库由 initTableModel.createTableImages 直接不包含该字段，无需运行本脚本。
 *
 * SQLite 不支持 DROP COLUMN，采用「建新表 → 迁移数据 → 删旧表 → 重命名」方案。
 *
 * @Usage: node scripts/tmp-scripts/migrate-images-remove-has-young-adult.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

// 新表结构（不含 has_young、has_adult）
const CREATE_IMAGES_NEW = `
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
    media_type TEXT DEFAULT 'image',
    duration_sec REAL,
    video_codec TEXT,
    file_size_bytes INTEGER,
    mime TEXT,
    created_at INTEGER,
    deleted_at INTEGER,
    alt_text TEXT DEFAULT NULL,
    ocr_text TEXT DEFAULT NULL,
    keywords TEXT DEFAULT NULL,
    object_tags TEXT DEFAULT NULL,
    face_count INTEGER DEFAULT NULL,
    person_count INTEGER DEFAULT NULL,
    expression_tags TEXT DEFAULT NULL,
    age_tags TEXT DEFAULT NULL,
    gender_tags TEXT DEFAULT NULL,
    primary_face_quality REAL DEFAULT NULL,
    primary_expression_confidence REAL DEFAULT NULL,
    analysis_version TEXT DEFAULT '1.0',
    aesthetic_score REAL DEFAULT NULL,
    sharpness_score REAL DEFAULT NULL,
    is_favorite INTEGER DEFAULT 0 NOT NULL,
    is_blurry INTEGER DEFAULT 0,
    UNIQUE (user_id, image_hash),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

// 插入时排除 has_young、has_adult
const INSERT_SQL = `
  INSERT INTO images_new (
    id, user_id, original_storage_key, high_res_storage_key, thumbnail_storage_key,
    image_created_at, image_hash, image_phash, image_dhash,
    year_key, month_key, date_key, day_key,
    gps_latitude, gps_longitude, gps_altitude, gps_location, country, city,
    width_px, height_px, aspect_ratio, raw_orientation, layout_type,
    hd_width_px, hd_height_px, storage_type, media_type, duration_sec, video_codec,
    file_size_bytes, mime, created_at, deleted_at,
    alt_text, ocr_text, keywords, object_tags,
    face_count, person_count, expression_tags, age_tags, gender_tags,
    primary_face_quality, primary_expression_confidence,
    analysis_version, aesthetic_score, sharpness_score, is_favorite, is_blurry
  ) SELECT
    id, user_id, original_storage_key, high_res_storage_key, thumbnail_storage_key,
    image_created_at, image_hash, image_phash, image_dhash,
    year_key, month_key, date_key, day_key,
    gps_latitude, gps_longitude, gps_altitude, gps_location, country, city,
    width_px, height_px, aspect_ratio, raw_orientation, layout_type,
    hd_width_px, hd_height_px, storage_type, media_type, duration_sec, video_codec,
    file_size_bytes, mime, created_at, deleted_at,
    alt_text, ocr_text, keywords, object_tags,
    face_count, person_count, expression_tags, age_tags, gender_tags,
    primary_face_quality, primary_expression_confidence,
    analysis_version, aesthetic_score, sharpness_score, is_favorite, is_blurry
  FROM images
`;

function migrate() {
  const info = db.prepare("PRAGMA table_info(images)").all();
  const hasYoung = info.some((col) => col.name === "has_young");
  const hasAdult = info.some((col) => col.name === "has_adult");
  if (!hasYoung && !hasAdult) {
    console.log("images 表已无 has_young、has_adult 列，跳过迁移");
    return;
  }

  console.log("开始迁移：移除 images.has_young、images.has_adult...");

  db.exec("BEGIN TRANSACTION");
  try {
    // 1. 删除 FTS 触发器
    db.prepare("DROP TRIGGER IF EXISTS images_fts_update").run();
    db.prepare("DROP TRIGGER IF EXISTS images_fts_insert").run();
    db.prepare("DROP TRIGGER IF EXISTS images_fts_delete").run();

    // 2. 删除 FTS 虚拟表
    db.prepare("DROP TABLE IF EXISTS images_fts").run();

    // 3. 创建新表（无 has_young、has_adult）
    db.prepare(CREATE_IMAGES_NEW).run();

    // 4. 迁移数据
    db.prepare(INSERT_SQL).run();

    // 5. 删除旧表
    db.prepare("DROP TABLE images").run();

    // 6. 重命名新表
    db.prepare("ALTER TABLE images_new RENAME TO images").run();

    // 7. 重建索引（不含 idx_images_user_age_flags）
    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_images_hash ON images(image_hash)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_hash ON images(user_id, image_hash)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_creation_desc ON images(user_id, image_created_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_year_creation ON images(user_id, year_key, image_created_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_month_creation ON images(user_id, month_key, image_created_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_storage_creation ON images(user_id, storage_type, image_created_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_year ON images(user_id, year_key)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_month ON images(user_id, month_key)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_date_creation ON images(user_id, date_key, image_created_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_day_creation ON images(user_id, day_key, image_created_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_date ON images(user_id, date_key)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_day ON images(user_id, day_key)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_aspect_ratio ON images(user_id, aspect_ratio)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_mime ON images(user_id, mime)",
      "CREATE INDEX IF NOT EXISTS idx_images_media_type ON images(media_type)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_media_creation ON images(user_id, media_type, image_created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_face_count ON images(user_id, face_count)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_person_count ON images(user_id, person_count)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_city ON images(user_id, city) WHERE city IS NOT NULL AND city != ''",
      "CREATE INDEX IF NOT EXISTS idx_images_user_layout_type ON images(user_id, layout_type) WHERE layout_type IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_images_user_aesthetic ON images(user_id, aesthetic_score)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_is_favorite ON images(user_id, is_favorite)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_is_blurry ON images(user_id, is_blurry)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_is_blurry_sharpness ON images(user_id, is_blurry, sharpness_score)",
      "CREATE INDEX IF NOT EXISTS idx_images_phash ON images(image_phash)",
      "CREATE INDEX IF NOT EXISTS idx_images_dhash ON images(image_dhash)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_deleted ON images(user_id, deleted_at) WHERE deleted_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_images_user_deleted_at ON images(user_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_images_user_year_deleted ON images(user_id, year_key, deleted_at) WHERE deleted_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_images_user_month_deleted ON images(user_id, month_key, deleted_at) WHERE deleted_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_images_user_date_deleted ON images(user_id, date_key, deleted_at) WHERE deleted_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_images_primary_face_quality ON images(primary_face_quality) WHERE primary_face_quality IS NOT NULL",
    ];
    indexes.forEach((sql) => db.prepare(sql).run());

    // 8. 重建 FTS5 虚拟表
    db.prepare(`
      CREATE VIRTUAL TABLE images_fts USING fts5(
        alt_text, ocr_text, keywords, object_tags,
        expression_tags, age_tags, gender_tags, country, city, layout_type,
        content='images', content_rowid='id'
      )
    `).run();

    // 9. 从 images 同步数据到 images_fts
    db.prepare(`
      INSERT INTO images_fts(images_fts) VALUES('rebuild')
    `).run();

    // 10. 重建 FTS 触发器
    db.prepare(`
      CREATE TRIGGER images_fts_update AFTER UPDATE ON images BEGIN
        INSERT OR REPLACE INTO images_fts(rowid, alt_text, ocr_text, keywords, object_tags, expression_tags, age_tags, gender_tags, country, city, layout_type)
        VALUES (new.id, new.alt_text, new.ocr_text, new.keywords, new.object_tags, new.expression_tags, new.age_tags, new.gender_tags, new.country, new.city, new.layout_type);
      END
    `).run();
    db.prepare(`
      CREATE TRIGGER images_fts_insert AFTER INSERT ON images BEGIN
        INSERT INTO images_fts(rowid, alt_text, ocr_text, keywords, object_tags, expression_tags, age_tags, gender_tags, country, city, layout_type)
        VALUES (new.id, new.alt_text, new.ocr_text, new.keywords, new.object_tags, new.expression_tags, new.age_tags, new.gender_tags, new.country, new.city, new.layout_type);
      END
    `).run();
    db.prepare(`
      CREATE TRIGGER images_fts_delete AFTER DELETE ON images BEGIN
        DELETE FROM images_fts WHERE rowid = old.id;
      END
    `).run();

    db.exec("COMMIT");
    console.log("✅ 迁移完成：images 表已移除 has_young、has_adult 列及 idx_images_user_age_flags 索引");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败：", err.message);
    throw err;
  }
}

migrate();
