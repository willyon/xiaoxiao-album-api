/*
 * 迁移：media.primary_face_quality -> media.preferred_face_quality
 *
 * 说明：
 * - 字段语义已调整为「优先 happy/neutral，否则回退全部人脸」的最高质量分；
 * - 新命名 preferred_face_quality 更贴合当前业务含义。
 *
 * 用法（在 xiaoxiao-project-service 根目录）：
 *   node scripts/tmp-scripts/migrate-media-rename-primary-face-quality.js
 *
 * 备注：
 * - SQLite 不支持直接重命名列到复杂兼容场景，采用重建表方案；
 * - 若已完成迁移（不存在 primary_face_quality），脚本会安全跳过。
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function getTableInfo(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function migrate() {
  if (!tableExists("media")) {
    console.log("media 表不存在，跳过迁移");
    return;
  }

  const info = getTableInfo("media");
  const hasOld = info.some((c) => c.name === "primary_face_quality");
  const hasNew = info.some((c) => c.name === "preferred_face_quality");
  if (!hasOld) {
    console.log("media.primary_face_quality 不存在，跳过迁移");
    return;
  }
  if (hasNew) {
    console.log("media.preferred_face_quality 已存在，跳过迁移");
    return;
  }

  console.log("开始迁移：将 media.primary_face_quality 重命名为 preferred_face_quality ...");

  db.exec("BEGIN TRANSACTION");
  try {
    db.prepare(`
      CREATE TABLE media_new (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        original_storage_key TEXT,
        high_res_storage_key TEXT,
        thumbnail_storage_key TEXT,
        mime TEXT,
        file_size_bytes INTEGER,
        file_hash TEXT,
        phash TEXT,
        dhash TEXT,
        media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video')),
        width_px INTEGER,
        height_px INTEGER,
        aspect_ratio REAL,
        raw_orientation INTEGER,
        layout_type TEXT,
        hd_width_px INTEGER,
        hd_height_px INTEGER,
        captured_at INTEGER,
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
        duration_sec REAL,
        video_codec TEXT,
        meta_pipeline_status TEXT DEFAULT 'pending' CHECK (meta_pipeline_status IN ('pending','running','success','failed')),
        deleted_at INTEGER,
        created_at INTEGER,
        is_favorite INTEGER DEFAULT 0 NOT NULL,
        ai_description TEXT,
        ai_keywords_json TEXT,
        ai_subject_tags_json TEXT,
        ai_action_tags_json TEXT,
        ai_scene_tags_json TEXT,
        ai_ocr TEXT,
        analysis_status TEXT DEFAULT 'pending' CHECK (analysis_status IN ('pending','running','done','failed')),
        aesthetic_score REAL,
        sharpness_score REAL,
        is_blurry INTEGER DEFAULT 0 NOT NULL,
        face_count INTEGER DEFAULT 0,
        person_count INTEGER DEFAULT 0,
        preferred_face_quality REAL,
        expression_tags TEXT,
        age_tags TEXT,
        gender_tags TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, file_hash)
      );
    `).run();

    db.prepare(`
      INSERT INTO media_new (
        id, user_id,
        original_storage_key, high_res_storage_key, thumbnail_storage_key,
        mime, file_size_bytes,
        file_hash, phash, dhash,
        media_type,
        width_px, height_px, aspect_ratio, raw_orientation, layout_type,
        hd_width_px, hd_height_px,
        captured_at,
        year_key, month_key, date_key, day_key,
        gps_latitude, gps_longitude, gps_altitude, gps_location, country, city,
        duration_sec, video_codec,
        meta_pipeline_status,
        deleted_at, created_at,
        is_favorite,
        ai_description, ai_keywords_json, ai_subject_tags_json, ai_action_tags_json, ai_scene_tags_json, ai_ocr,
        analysis_status,
        aesthetic_score, sharpness_score,
        is_blurry,
        face_count, person_count,
        preferred_face_quality,
        expression_tags, age_tags, gender_tags
      )
      SELECT
        id, user_id,
        original_storage_key, high_res_storage_key, thumbnail_storage_key,
        mime, file_size_bytes,
        file_hash, phash, dhash,
        media_type,
        width_px, height_px, aspect_ratio, raw_orientation, layout_type,
        hd_width_px, hd_height_px,
        captured_at,
        year_key, month_key, date_key, day_key,
        gps_latitude, gps_longitude, gps_altitude, gps_location, country, city,
        duration_sec, video_codec,
        ingest_status,
        deleted_at, created_at,
        is_favorite,
        ai_description, ai_keywords_json, ai_subject_tags_json, ai_action_tags_json, ai_scene_tags_json, ai_ocr,
        analysis_status,
        aesthetic_score, sharpness_score,
        is_blurry,
        face_count, person_count,
        primary_face_quality,
        expression_tags, age_tags, gender_tags
      FROM media;
    `).run();

    db.prepare("DROP TABLE media").run();
    db.prepare("ALTER TABLE media_new RENAME TO media").run();

    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_captured_at ON media(user_id, captured_at DESC, id DESC);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_date_key ON media(user_id, date_key);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_city ON media(user_id, city) WHERE city IS NOT NULL AND city != '';").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_deleted ON media(user_id, deleted_at);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_type ON media(user_id, media_type);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_favorite ON media(user_id, is_favorite);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_analysis_status ON media(user_id, analysis_status);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_status_face ON media(analysis_status, face_count);").run();

    db.exec("COMMIT");
    console.log("✅ 迁移完成：media.preferred_face_quality 已生效");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", error);
    throw error;
  }
}

migrate();

