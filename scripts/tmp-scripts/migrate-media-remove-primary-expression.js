/*
 * 迁移：从 media 表移除 primary_expression / primary_expression_confidence 两列。
 *
 * 背景：
 * - 业务逻辑已全部改为使用 expression_tags 表示整图表情集合；
 * - primary_expression / primary_expression_confidence 已不再写入或读取，仅遗留历史结构；
 * - 本脚本通过「新表 → 迁移数据 → 删旧表 → 重命名」的方式物理删除这两列。
 *
 * ⚠️ 注意：
 * - 请在 xiaoxiao-project-service 根目录执行：
 *     node scripts/tmp-scripts/migrate-media-remove-primary-expression.js
 * - 建议在停机或低流量时执行，注意提前备份数据库；
 * - 可安全重复执行：若列已不存在则直接跳过。
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
  const hasPrimaryExpression = info.some((col) => col.name === "primary_expression");
  const hasPrimaryExpressionConf = info.some((col) => col.name === "primary_expression_confidence");

  if (!hasPrimaryExpression && !hasPrimaryExpressionConf) {
    console.log("media 表已无 primary_expression / primary_expression_confidence 列，跳过迁移");
    return;
  }

  console.log("开始迁移：从 media 表物理删除 primary_expression / primary_expression_confidence 列...");

  db.exec("BEGIN TRANSACTION");
  try {
    // 1. 创建新表 media_new：按当前实际 schema 拷贝，去掉 primary_expression / primary_expression_confidence
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

    // 2. 将旧表数据拷贝到新表（排除 primary_expression / primary_expression_confidence）
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
        preferred_face_quality,
        expression_tags, age_tags, gender_tags
      FROM media;
    `).run();

    // 3. 删旧表、重命名
    db.prepare("DROP TABLE media").run();
    db.prepare("ALTER TABLE media_new RENAME TO media").run();

    // 4. 重新创建与 media 相关的索引（与 initTableModel 保持一致）
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_captured_at ON media(user_id, captured_at DESC, id DESC);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_date_key ON media(user_id, date_key);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_city ON media(user_id, city) WHERE city IS NOT NULL AND city != '';").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_deleted ON media(user_id, deleted_at);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_type ON media(user_id, media_type);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_favorite ON media(user_id, is_favorite);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_analysis_status ON media(user_id, analysis_status);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_status_face ON media(analysis_status, face_count);").run();

    db.exec("COMMIT");
    console.log("✅ 迁移完成：media 表已移除 primary_expression / primary_expression_confidence 列");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚事务：", error);
    throw error;
  }
}

migrate();

