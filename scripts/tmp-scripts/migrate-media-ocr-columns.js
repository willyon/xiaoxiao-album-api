/**
 * 将旧版 media_ocr 列（ocr_text、blocks_json）收敛为与 media_captions 一致的 ocr 单列。
 * 需要 SQLite 3.35+（DROP COLUMN）与 3.25+（RENAME COLUMN）。
 *
 * 使用：node scripts/tmp-scripts/migrate-media-ocr-columns.js
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

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function upgradeMediaOcrTableIfNeeded() {
  if (!tableExists("media_ocr")) {
    console.log("ℹ️  无 media_ocr 表，跳过。");
    return;
  }
  let names = new Set(columnNames("media_ocr"));
  if (names.has("blocks_json")) {
    try {
      db.prepare("ALTER TABLE media_ocr DROP COLUMN blocks_json").run();
      console.log("✅ 已删除列 media_ocr.blocks_json");
    } catch (e) {
      console.warn("⚠️  删除 blocks_json 失败（需 SQLite 3.35+）:", e.message);
    }
    names = new Set(columnNames("media_ocr"));
  }
  if (names.has("ocr_text") && !names.has("ocr")) {
    try {
      db.prepare("ALTER TABLE media_ocr RENAME COLUMN ocr_text TO ocr").run();
      console.log("✅ 已将 media_ocr.ocr_text 重命名为 ocr");
    } catch (e) {
      console.warn("⚠️  重命名 ocr_text 失败（需 SQLite 3.25+）:", e.message);
    }
  } else if (names.has("ocr")) {
    console.log("ℹ️  media_ocr 已是 ocr 列，无需迁移。");
  }
}

if (require.main === module) {
  upgradeMediaOcrTableIfNeeded();
}

module.exports = { upgradeMediaOcrTableIfNeeded };
