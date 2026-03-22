/*
 * 一次性迁移：从 media 表删除 ai_visible_text 列（需 SQLite 3.35+）
 * 请先运行 migrate-media-copy-ai-visible-text-to-ai-ocr.js（若仍有数据仅在 ai_visible_text），再执行本脚本。
 * 新库由 initTableModel.createTableMedia 已不再包含该列，无需运行。
 *
 * @Usage: node scripts/tmp-scripts/migrate-media-drop-ai-visible-text.js
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
  if (!names.has("ai_visible_text")) {
    console.log("media 无 ai_visible_text 列，跳过");
    return;
  }
  db.prepare("ALTER TABLE media DROP COLUMN ai_visible_text").run();
  console.log("✅ 已删除 media.ai_visible_text");
}

migrate();
