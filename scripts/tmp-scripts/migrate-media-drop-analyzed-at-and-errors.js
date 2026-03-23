/*
 * 一次性迁移：从 media 表删除 analyzed_at、last_error、last_error_at（SQLite 3.35+ DROP COLUMN）。
 * 成功与否仅以 analysis_status 为准；重跑脚本请按 analysis_status 筛选。
 *
 * 新库请使用 initTableModel.createTableMedia（已无上述列），无需运行本脚本。
 * 可重跑：某列已不存在则跳过该列。
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-media-drop-analyzed-at-and-errors.js
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

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function dropColumnIfExists(table, col) {
  if (!tableExists(table)) {
    console.log(`表 ${table} 不存在，跳过 ${col}`);
    return;
  }
  const cols = columnNames(table);
  if (!cols.includes(col)) {
    console.log(`${table} 已无 ${col}，跳过`);
    return;
  }
  db.prepare(`ALTER TABLE ${table} DROP COLUMN ${col}`).run();
  console.log(`✅ 已删除列 ${table}.${col}`);
}

function migrate() {
  const tx = db.transaction(() => {
    dropColumnIfExists("media", "analyzed_at");
    dropColumnIfExists("media", "last_error");
    dropColumnIfExists("media", "last_error_at");
  });

  try {
    tx();
  } catch (e) {
    console.error("迁移失败（若 SQLite 版本 < 3.35 不支持 DROP COLUMN，请升级或手动重建 media 表）:", e.message);
    process.exitCode = 1;
    return;
  }

  console.log("迁移结束");
}

migrate();
