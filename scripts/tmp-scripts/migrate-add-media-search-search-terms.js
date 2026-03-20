/*
 * @Description: 为 media_search / media_search_fts 增加 search_terms 列（任务 1），并重建 FTS 与文档内容。
 * @Usage: node scripts/tmp-scripts/migrate-add-media-search-search-terms.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableMediaSearchFts } = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { rebuildMediaSearchDoc } = require(path.join(projectRoot, "src", "models", "mediaModel"));

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function migrate() {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_search'").get()) {
    console.error("❌ 未找到 media_search 表");
    process.exit(1);
  }

  if (columnExists("media_search", "search_terms")) {
    console.log("ℹ️  media_search.search_terms 已存在，跳过加列");
  } else {
    console.log("📝 ALTER TABLE media_search ADD COLUMN search_terms …");
    db.prepare("ALTER TABLE media_search ADD COLUMN search_terms TEXT").run();
    console.log("   ✅ 已添加列 search_terms");
  }

  console.log("📝 重建 media_search_fts 与触发器（列结构变更）…");
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();
  db.prepare("DROP TABLE IF EXISTS media_search_fts").run();
  createTableMediaSearchFts();
  console.log("   ✅ 已创建 media_search_fts");

  console.log("📝 FTS rebuild（从 media_search 回填）…");
  db.prepare("INSERT INTO media_search_fts(media_search_fts) VALUES('rebuild')").run();
  console.log("   ✅ rebuild 完成");

  const ids = db.prepare("SELECT id FROM media WHERE deleted_at IS NULL ORDER BY id ASC").pluck().all();
  console.log(`📝 重写 search_terms 与 media_search_terms（共 ${ids.length} 条媒体）…`);
  let n = 0;
  for (const id of ids) {
    rebuildMediaSearchDoc(id);
    n += 1;
    if (n % 500 === 0) console.log(`   … ${n}`);
  }
  console.log(`   ✅ 已处理 ${n} 条`);

  db.prepare("INSERT INTO media_search_fts(media_search_fts) VALUES('rebuild')").run();
  console.log("   ✅ 再次 FTS rebuild 完成");
}

function main() {
  db.prepare("BEGIN").run();
  try {
    migrate();
    db.prepare("COMMIT").run();
    console.log("🎉 迁移完成");
  } catch (e) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 迁移失败:", e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrate };
