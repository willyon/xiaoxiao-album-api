/*
 * 一次性迁移：将 media 上 meta 流水线状态列全部更新为 'success'。
 * 列名：meta_pipeline_status（若仍为 ingest_status 则兼容更新）。
 *
 *   node scripts/tmp-scripts/migrate-media-force-ingest-status-success.js
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

function migrate() {
  if (!tableExists("media")) {
    console.log("media 表不存在，跳过");
    return;
  }

  const cols = db.prepare("PRAGMA table_info(media)").all();
  const names = new Set(cols.map((c) => c.name));
  const col = names.has("meta_pipeline_status") ? "meta_pipeline_status" : names.has("ingest_status") ? "ingest_status" : null;
  if (!col) {
    console.log("未找到 meta_pipeline_status / ingest_status，跳过");
    return;
  }

  db.exec("BEGIN TRANSACTION");
  try {
    const result = db.prepare(`UPDATE media SET ${col} = 'success'`).run();
    db.exec("COMMIT");
    console.log(`✅ 已将 media.${col} 全部更新为 'success'，受影响行数：${result.changes}`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}

migrate();
