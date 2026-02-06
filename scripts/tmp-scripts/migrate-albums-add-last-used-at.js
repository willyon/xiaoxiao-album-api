/*
 * 一次性迁移：为已存在的 albums 表添加 last_used_at 列并回填（created_at）
 * 新库由 initTableModel.createTableAlbums 直接包含该字段，无需运行本脚本。
 *
 * @Usage: node scripts/tmp-scripts/migrate-albums-add-last-used-at.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function migrate() {
  const info = db.prepare("PRAGMA table_info(albums)").all();
  const hasColumn = info.some((col) => col.name === "last_used_at");
  if (hasColumn) {
    console.log("albums 表已存在 last_used_at，跳过迁移");
    return;
  }

  db.prepare("ALTER TABLE albums ADD COLUMN last_used_at INTEGER").run();
  db.prepare("UPDATE albums SET last_used_at = created_at WHERE last_used_at IS NULL").run();

  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_albums_user_last_used ON albums(user_id, last_used_at DESC) WHERE deleted_at IS NULL",
  ).run();

  console.log("✅ 迁移完成：albums 表已添加 last_used_at 并回填，已创建索引");
}

migrate();
