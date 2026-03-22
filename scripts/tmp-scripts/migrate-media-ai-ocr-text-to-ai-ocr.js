/*
 * 一次性迁移：将 media.ai_ocr_text 重命名为 media.ai_ocr（需 SQLite 3.25+）
 * 新库由 initTableModel.createTableMedia 直接为 ai_ocr，无需运行本脚本。
 *
 * @Usage: node scripts/tmp-scripts/migrate-media-ai-ocr-text-to-ai-ocr.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function migrate() {
  const info = db.prepare("PRAGMA table_info(media)").all();
  const names = new Set(info.map((c) => c.name));
  if (names.has("ai_ocr") && !names.has("ai_ocr_text")) {
    console.log("media 已使用 ai_ocr，跳过");
    return;
  }
  if (!names.has("ai_ocr_text")) {
    console.log("media 无 ai_ocr_text 列（若为新库请确认 initTableModel 已含 ai_ocr）");
    return;
  }
  db.prepare("ALTER TABLE media RENAME COLUMN ai_ocr_text TO ai_ocr").run();
  console.log("✅ media.ai_ocr_text 已重命名为 ai_ocr");
}

migrate();
