/*
 * 一次性迁移：从 media 表删除 analysis_version 列（SQLite 3.35+ ALTER TABLE DROP COLUMN）。
 *
 * 子表 analysis_version 删除见 migrate-drop-subtable-analysis-version.js。
 *
 * 新库请使用 initTableModel.createTableMedia（已无 analysis_version），无需运行本脚本。
 * 可重跑：列已不存在则跳过。
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-media-drop-analysis-version.js
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
  if (!cols.includes("analysis_version")) {
    console.log("media 已无 analysis_version 列，跳过");
    return;
  }

  try {
    db.prepare("ALTER TABLE media DROP COLUMN analysis_version").run();
    console.log("✅ 已删除列 media.analysis_version");
  } catch (e) {
    console.error("迁移失败（若 SQLite 版本 < 3.35 不支持 DROP COLUMN，请升级或手动重建 media 表）:", e.message);
    process.exitCode = 1;
    return;
  }

  console.log("迁移结束");
}

migrate();
