/*
 * 一次性迁移：将 media.ingest_status 统一改为 'success'（成功态）
 *
 * 使用场景（示例）：
 * - 早期数据未显式写入 ingest_status（NULL），现在希望统一视为已完成基础处理；
 * - 历史上使用 'ready' 作为成功标记，现阶段统一改用 'success'。
 *
 * 行为说明：
 * - 若 media 表不存在，直接跳过；
 * - 仅对以下记录更新：
 *   - ingest_status IS NULL
 *   - ingest_status = 'ready'
 * - 其它取值（如 'pending' / 'processing' / 'failed'）不做修改。
 *
 * 使用方式（在 xiaoxiao-project-service 根目录执行）：
 *   node scripts/tmp-scripts/migrate-media-ingest-status-to-success.js
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
  if (!cols.includes("ingest_status")) {
    console.log("media 表无 ingest_status 列，跳过");
    return;
  }

  db.exec("BEGIN TRANSACTION");
  try {
    const updatedReady = db.prepare("UPDATE media SET ingest_status = 'success' WHERE ingest_status = 'ready'").run();
    const updatedNull = db.prepare("UPDATE media SET ingest_status = 'success' WHERE ingest_status IS NULL").run();

    db.exec("COMMIT");

    console.log(
      `✅ 迁移完成：已将 ingest_status=ready / NULL 统一改为 'success' （ready->success: ${updatedReady.changes} 行，NULL->success: ${updatedNull.changes} 行）`,
    );
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}

migrate();

