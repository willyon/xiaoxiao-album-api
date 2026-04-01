/*
 * 一次性迁移：从以下表删除 analysis_version 列（SQLite 3.35+ DROP COLUMN）
 *   media_face_embeddings, media_embeddings
 *
 * 新库请使用 initTableModel 对应 createTable*（已无 analysis_version），无需运行本脚本。
 * 可重跑：某表已无该列则跳过该表。
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-drop-subtable-analysis-version.js
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

function dropColumnIfExists(table) {
  if (!tableExists(table)) {
    console.log(`表 ${table} 不存在，跳过`);
    return;
  }
  const cols = columnNames(table);
  if (!cols.includes("analysis_version")) {
    console.log(`${table} 已无 analysis_version，跳过`);
    return;
  }
  db.prepare(`ALTER TABLE ${table} DROP COLUMN analysis_version`).run();
  console.log(`✅ 已删除列 ${table}.analysis_version`);
}

function migrate() {
  const tx = db.transaction(() => {
    dropColumnIfExists("media_face_embeddings");
    dropColumnIfExists("media_embeddings");
  });

  try {
    tx();
  } catch (e) {
    console.error("迁移失败（若 SQLite 版本 < 3.35 不支持 DROP COLUMN，请升级或手动重建表）:", e.message);
    process.exitCode = 1;
    return;
  }

  console.log("迁移结束");
}

migrate();
