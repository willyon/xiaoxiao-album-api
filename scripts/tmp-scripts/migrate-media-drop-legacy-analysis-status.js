/*
 * 一次性迁移脚本：从 media 表中删除旧字段 analysis_status 及其相关索引。
 *
 * 背景：
 * - 早期使用 media.analysis_status（pending/running/done/failed）表示整体分析状态。
 * - 新设计已经引入 analysis_status_primary / analysis_status_cloud，并在业务中全面替代旧字段。
 * - 目前 analysis_status 仅作为冗余列存在，且仍有索引 idx_media_user_analysis_status / idx_media_status_face。
 *
 * 本脚本会执行以下操作：
 * 1. 检查 media 表是否存在 analysis_status 列；若不存在则直接退出。
 * 2. 重建 media 表结构：新表不再包含 analysis_status 列。
 * 3. 将旧表数据完整复制到新表（除 analysis_status 外的所有列保持不变）。
 * 4. 删除旧表，重命名新表为 media。
 * 5. 重新创建与 media 表相关的索引（不再包含基于 analysis_status 的索引）。
 *
 * 使用方式：
 *   NODE_ENV=production node scripts/tmp-scripts/migrate-media-drop-legacy-analysis-status.js
 *
 * ⚠️ 注意：
 * - 建议在执行前手动备份数据库文件。
 * - 本脚本设计为幂等：若 analysis_status 已不存在，则不会做任何破坏性操作。
 */

const path = require("path");
const { db } = require("../../src/services/database");

function getTableInfo(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName});`).all();
}

function getIndexList(tableName) {
  return db.prepare(`PRAGMA index_list(${tableName});`).all();
}

function migrate() {
  const info = getTableInfo("media");
  if (!info || info.length === 0) {
    console.log("ℹ️ 未找到 media 表，跳过迁移。");
    return;
  }

  const hasLegacyAnalysisStatus = info.some((c) => c.name === "analysis_status");
  if (!hasLegacyAnalysisStatus) {
    console.log("ℹ️ media.analysis_status 列已不存在，无需迁移。");
    return;
  }

  console.log("🔧 检测到 media.analysis_status 列，准备执行表重建以删除该列…");

  db.exec("BEGIN TRANSACTION");
  try {
    // 1）创建临时新表（不包含 analysis_status 列）
    db.prepare(
      `
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
        ingest_status TEXT DEFAULT 'pending',
        deleted_at INTEGER,
        created_at INTEGER,
        is_favorite INTEGER DEFAULT 0 NOT NULL,
        ai_description TEXT,
        ai_keywords_json TEXT,
        ai_subject_tags_json TEXT,
        ai_action_tags_json TEXT,
        ai_scene_tags_json TEXT,
        ai_ocr TEXT,
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
    `,
    ).run();

    console.log("✅ 已创建临时表 media_new（不含 analysis_status 列）");

    // 2）从旧表复制数据到新表（排除 analysis_status 列）
    db.prepare(
      `
      INSERT INTO media_new (
        id,
        user_id,
        original_storage_key,
        high_res_storage_key,
        thumbnail_storage_key,
        mime,
        file_size_bytes,
        file_hash,
        phash,
        dhash,
        media_type,
        width_px,
        height_px,
        aspect_ratio,
        raw_orientation,
        layout_type,
        hd_width_px,
        hd_height_px,
        captured_at,
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
        duration_sec,
        video_codec,
        ingest_status,
        deleted_at,
        created_at,
        is_favorite,
        ai_description,
        ai_keywords_json,
        ai_subject_tags_json,
        ai_action_tags_json,
        ai_scene_tags_json,
        ai_ocr,
        aesthetic_score,
        sharpness_score,
        is_blurry,
        face_count,
        person_count,
        preferred_face_quality,
        expression_tags,
        age_tags,
        gender_tags,
        analysis_status_primary,
        analysis_status_cloud
      )
      SELECT
        id,
        user_id,
        original_storage_key,
        high_res_storage_key,
        thumbnail_storage_key,
        mime,
        file_size_bytes,
        file_hash,
        phash,
        dhash,
        media_type,
        width_px,
        height_px,
        aspect_ratio,
        raw_orientation,
        layout_type,
        hd_width_px,
        hd_height_px,
        captured_at,
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
        duration_sec,
        video_codec,
        ingest_status,
        deleted_at,
        created_at,
        is_favorite,
        ai_description,
        ai_keywords_json,
        ai_subject_tags_json,
        ai_action_tags_json,
        ai_scene_tags_json,
        ai_ocr,
        aesthetic_score,
        sharpness_score,
        is_blurry,
        face_count,
        person_count,
        preferred_face_quality,
        expression_tags,
        age_tags,
        gender_tags,
        analysis_status_primary,
        analysis_status_cloud
      FROM media;
    `,
    ).run();

    console.log("✅ 已将旧表 media 数据复制到 media_new（不含 analysis_status 列）");

    // 3）删除旧表并重命名新表
    db.prepare("DROP TABLE media;").run();
    db.prepare("ALTER TABLE media_new RENAME TO media;").run();

    console.log("✅ 已删除旧表 media，并将 media_new 重命名为 media");

    // 4）重新创建索引（不再包含基于 analysis_status 的索引）
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_captured_at ON media(user_id, captured_at DESC, id DESC);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_date_key ON media(user_id, date_key);").run();
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_media_user_city ON media(user_id, city) WHERE city IS NOT NULL AND city != '';",
    ).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_deleted ON media(user_id, deleted_at);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_type ON media(user_id, media_type);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_favorite ON media(user_id, is_favorite);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_analysis_status_primary ON media(analysis_status_primary);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_analysis_status_cloud   ON media(analysis_status_cloud);").run();

    console.log("✅ 已重新创建 media 相关索引（不含 analysis_status 索引）");

    db.exec("COMMIT");
    console.log("🎉 迁移完成：media.analysis_status 列及相关索引已移除。");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚。错误信息：", error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const dbPath = db.name || path.join(process.cwd(), "data", "database.sqlite");
  console.log(`开始迁移数据库：${dbPath}`);
  migrate();
}

