/*
 * 一次性迁移：将 media 表中所有 ingest_status 统一更新为 'success'。
 *
 * 使用方式（在 xiaoxiao-project-service 根目录执行）：
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

  db.exec("BEGIN TRANSACTION");
  try {
    const result = db.prepare("UPDATE media SET ingest_status = 'success'").run();
    db.exec("COMMIT");
    console.log(`✅ 已将 media.ingest_status 全部更新为 'success'，受影响行数：${result.changes}`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}

migrate();

