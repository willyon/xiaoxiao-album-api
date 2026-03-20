/*
 * @Description: 将 FTS5 虚拟表 media_fts 重命名为 media_search_fts（与 media_search 命名一致）。
 * 删除旧表与触发器后按 initTableModel 重建，并从 media_search 执行 FTS rebuild 回填索引。
 *
 * @Usage: node scripts/tmp-scripts/migrate-rename-media-fts-to-media-search-fts.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableMediaSearchFts } = require(path.join(projectRoot, "src", "models", "initTableModel"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name) != null;
}

function migrateRenameMediaFtsToMediaSearchFts() {
  const hasOld = tableExists("media_fts");
  const hasNew = tableExists("media_search_fts");

  if (hasNew && !hasOld) {
    console.log("ℹ️  已存在 media_search_fts 且无 media_fts，跳过迁移");
    return { skipped: true };
  }

  console.log("🚀 开始迁移：media_fts → media_search_fts");

  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();

  db.prepare("DROP TABLE IF EXISTS media_fts").run();
  db.prepare("DROP TABLE IF EXISTS media_search_fts").run();
  console.log("   ✅ 已删除旧 FTS 表");

  createTableMediaSearchFts();
  console.log("   ✅ 已创建 media_search_fts 与同步触发器");

  db.prepare("INSERT INTO media_search_fts(media_search_fts) VALUES('rebuild')").run();
  console.log("   ✅ 已从 media_search 重建 FTS 索引");

  return { skipped: false };
}

function main() {
  if (!tableExists("media_search")) {
    console.error("❌ 未找到 media_search 表，无法迁移");
    process.exit(1);
  }

  db.prepare("BEGIN").run();
  try {
    const result = migrateRenameMediaFtsToMediaSearchFts();
    db.prepare("COMMIT").run();
    console.log(result.skipped ? "🎉 无需迁移" : "🎉 迁移完成");
  } catch (error) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 迁移失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrateRenameMediaFtsToMediaSearchFts };
