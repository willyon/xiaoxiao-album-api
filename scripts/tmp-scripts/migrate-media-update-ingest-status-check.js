/*
 * 迁移：更新 media.ingest_status 的 CHECK 约束以支持 'success'，
 * 并将旧值 ready/NULL 统一迁移为 'success'。
 *
 * 说明：
 * - 原表结构来自 initTableModel.createTableMedia，CHECK 仅允许
 *   ('pending','processing','ready','failed')；
 * - 本脚本通过「重建表」方式，将 CHECK 调整为
 *   ('pending','processing','ready','failed','success')；
 * - 同时在迁移过程中，将：
 *     ingest_status = 'ready' 或 NULL → 'success'
 *   其它值保持不变。
 *
 * 注意：
 * - 保留现有所有列（包括 analysis_status_primary / analysis_status_cloud，如已存在）与索引；
 * - 在 xiaoxiao-project-service 根目录执行：
 *     node scripts/tmp-scripts/migrate-media-update-ingest-status-check.js
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
  const hasIngestStatus = info.some((c) => c.name === "ingest_status");
  if (!hasIngestStatus) {
    console.log("media.ingest_status 不存在，跳过迁移");
    return;
  }

  const hasPrimaryStatus = info.some((c) => c.name === "analysis_status_primary");
  const hasCloudStatus = info.some((c) => c.name === "analysis_status_cloud");
  if (!hasPrimaryStatus || !hasCloudStatus) {
    console.log("media.analysis_status_primary / analysis_status_cloud 尚未就绪，请先运行相应迁移脚本，再执行本脚本。");
    return;
  }

  console.log("开始迁移：重建 media 表以更新 ingest_status CHECK 约束，并将 ready/NULL 映射为 'success' ...");

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
        ingest_status TEXT DEFAULT 'pending' CHECK (ingest_status IN ('pending','processing','ready','failed','success')),
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
        analysis_status_primary TEXT DEFAULT 'pending',
        analysis_status_cloud   TEXT DEFAULT 'pending',
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
        ingest_status,
        deleted_at, created_at,
        is_favorite,
        ai_description, ai_keywords_json, ai_subject_tags_json, ai_action_tags_json, ai_scene_tags_json, ai_ocr,
        analysis_status,
        aesthetic_score, sharpness_score,
        is_blurry,
        face_count, person_count,
        preferred_face_quality,
        expression_tags, age_tags, gender_tags,
        analysis_status_primary,
        analysis_status_cloud
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
        CASE
          WHEN ingest_status IS NULL THEN 'success'
          WHEN ingest_status = 'ready' THEN 'success'
          ELSE ingest_status
        END AS ingest_status,
        deleted_at, created_at,
        is_favorite,
        ai_description, ai_keywords_json, ai_subject_tags_json, ai_action_tags_json, ai_scene_tags_json, ai_ocr,
        analysis_status,
        aesthetic_score, sharpness_score,
        is_blurry,
        face_count, person_count,
        preferred_face_quality,
        expression_tags, age_tags, gender_tags,
        analysis_status_primary,
        analysis_status_cloud
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
    console.log("✅ 迁移完成：ingest_status CHECK 已更新为包含 'success'，且 ready/NULL 已映射为 'success'");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", error);
    throw error;
  }
}

migrate();

