/*
 * 【已废弃】历史迁移：为 media 表增加 ai_visible_text。当前统一使用 ai_ocr，新库勿运行。
 * 新库由 initTableModel.createTableMedia 直接包含该列，无需运行本脚本。
 *
 * @Usage: node scripts/tmp-scripts/migrate-media-add-ai-visible-text.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function addColumnIfMissing(table, columnName, ddl) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  if (info.some((col) => col.name === columnName)) {
    console.log(`${table} 已存在 ${columnName}，跳过`);
    return false;
  }
  db.prepare(ddl).run();
  console.log(`✅ ${table} 已添加 ${columnName}`);
  return true;
}

function migrate() {
  addColumnIfMissing("media", "ai_visible_text", "ALTER TABLE media ADD COLUMN ai_visible_text TEXT");
  console.log("迁移结束");
}

migrate();
