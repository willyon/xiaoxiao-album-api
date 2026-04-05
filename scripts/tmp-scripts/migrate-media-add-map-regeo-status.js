/*
 * 一次性迁移：为 media 表新增 map_regeo_status（线上地图逆地理终态），并建索引。
 * 取值：NULL | 'skipped' | 'success' | 'failed'（无列级 DEFAULT，与 analysis_status_cloud 一致）
 *
 * 可选：将已有 GPS、且 map_regeo_status 仍为 NULL 的行标为 skipped，
 * 便于在未记录历史的情况下用设置页「补跑」统一走线上逆地理（可能产生额外 API 调用）。
 *
 * 使用方式（xiaoxiao-project-service 根目录）：
 *   node scripts/tmp-scripts/migrate-media-add-map-regeo-status.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);
require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrate() {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media'").get()) {
    console.log("media 表不存在，跳过");
    return;
  }

  const cols = columnNames("media");

  db.exec("BEGIN TRANSACTION");
  try {
    if (!cols.includes("map_regeo_status")) {
      db.prepare("ALTER TABLE media ADD COLUMN map_regeo_status TEXT").run();
      console.log("✅ 已新增列 media.map_regeo_status TEXT（无 DEFAULT）");
    } else {
      console.log("ℹ️ media.map_regeo_status 已存在，跳过 ADD COLUMN");
    }

    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_media_user_map_regeo_status ON media(user_id, map_regeo_status)",
    ).run();
    console.log("✅ 索引 idx_media_user_map_regeo_status 已就绪");

    const backfill = db
      .prepare(
        `
      UPDATE media
      SET map_regeo_status = 'skipped'
      WHERE deleted_at IS NULL
        AND gps_latitude IS NOT NULL
        AND gps_longitude IS NOT NULL
        AND map_regeo_status IS NULL
    `,
      )
      .run();
    console.log(`✅ 已为历史含 GPS 且状态为 NULL 的行写入 map_regeo_status = 'skipped'（变更 ${backfill.changes} 行）`);

    db.exec("COMMIT");
    console.log("🎉 迁移完成：map_regeo_status");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}

migrate();
