/**
 * 一次性迁移：仅当库里仍有 media_search.ocr_search_terms 或 media_search_terms.field_type='ocr' 时需要。
 * 新库按 initTableModel 建表则无需执行。
 *
 * 步骤：
 * 1. 删除 media_search_terms 中 field_type = 'ocr' 的行
 * 2. 重建 media_search_fts（去掉 ocr_search_terms 列，与 initTableModel 一致）
 * 3. ALTER TABLE media_search DROP COLUMN ocr_search_terms（需 SQLite 3.35+）
 * 4. 对每条 media_search 调用 rebuildMediaSearchDoc 回填 FTS
 *
 * 用法（项目根 xiaoxiao-project-service）：
 *   node scripts/tmp-scripts/migrate-drop-ocr-search-terms-column.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableMediaSearchFts } = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { rebuildMediaSearchDoc } = require(path.join(projectRoot, "src", "models", "mediaModel"));

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnExists(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === col);
}

function main() {
  const verRow = db.prepare("SELECT sqlite_version() AS v").get();
  console.log("SQLite 版本:", verRow?.v);

  if (!tableExists("media_search")) {
    console.log("无 media_search 表，跳过。");
    return;
  }

  const del = db.prepare("DELETE FROM media_search_terms WHERE field_type = ?").run("ocr");
  console.log(`已删除 media_search_terms 中 field_type=ocr 行数: ${del.changes}`);

  console.log("重建 media_search_fts（7 列，不含 ocr_search_terms）…");
  createTableMediaSearchFts();

  if (columnExists("media_search", "ocr_search_terms")) {
    try {
      db.prepare("ALTER TABLE media_search DROP COLUMN ocr_search_terms").run();
      console.log("已从 media_search 删除 ocr_search_terms 列");
    } catch (e) {
      console.error("ALTER TABLE DROP COLUMN 失败（需 SQLite 3.35+）:", e.message);
      console.error("FTS 已清空，请先升级 SQLite / better-sqlite3 后重新运行本脚本完成删列与 rebuild。");
      process.exit(1);
    }
  } else {
    console.log("media_search 无 ocr_search_terms 列，跳过删列");
  }

  const ids = db.prepare("SELECT media_id FROM media_search").pluck().all();
  console.log(`正在对 ${ids.length} 条记录执行 rebuildMediaSearchDoc 以回填 FTS…`);
  for (let i = 0; i < ids.length; i += 1) {
    rebuildMediaSearchDoc(ids[i]);
    if ((i + 1) % 500 === 0 || i + 1 === ids.length) {
      console.log(`   … ${i + 1}/${ids.length}`);
    }
  }
  console.log("✅ 迁移完成");
}

main();
