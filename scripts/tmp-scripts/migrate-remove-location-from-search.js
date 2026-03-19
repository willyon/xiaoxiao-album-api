/*
 * @Description: 从 media_search / media_fts 中移除 location_text，重建相关表
 * 地点筛选使用 media.city 精确匹配，不再参与全文检索。
 *
 * @Usage: node scripts/tmp-scripts/migrate-remove-location-from-search.js
 *         node scripts/tmp-scripts/migrate-remove-location-from-search.js --userId=1
 *         node scripts/tmp-scripts/migrate-remove-location-from-search.js --userId=1 --limit=500
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  createTableMediaSearch,
  createTableMediaFts,
  createTableMediaSearchTerms,
} = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { rebuildMediaSearchIndexes } = require(path.join(projectRoot, "scripts", "tmp-scripts", "rebuild-media-search-indexes"));

async function migrateRemoveLocationFromSearch() {
  console.log("🚀 开始迁移：移除 media_search / media_fts 中的 location_text...");

  // 1. 删除 FTS 虚拟表（依赖 media_search 结构）
  db.prepare("DROP TABLE IF EXISTS media_fts").run();
  console.log("   ✅ 已删除 media_fts");

  // 2. 删除 media_search（需按新 schema 重建）
  db.prepare("DROP TABLE IF EXISTS media_search").run();
  console.log("   ✅ 已删除 media_search");

  // 3. 清空 media_search_terms
  db.prepare("DELETE FROM media_search_terms").run();
  console.log("   ✅ 已清空 media_search_terms");

  // 4. 按新 schema 创建 media_search（无 location_text）
  createTableMediaSearch();
  console.log("   ✅ 已创建 media_search（无 location_text）");

  // 5. 创建 media_fts
  createTableMediaFts();
  console.log("   ✅ 已创建 media_fts");

  // 6. 重建 media_search_terms 表结构（确保存在）
  createTableMediaSearchTerms();

  // 7. 批量重建所有媒体的搜索文档
  console.log("   📦 开始重建搜索索引...");
  await rebuildMediaSearchIndexes();
}

async function main() {
  db.prepare("BEGIN").run();
  try {
    await migrateRemoveLocationFromSearch();
    db.prepare("COMMIT").run();
    console.log("🎉 迁移完成");
  } catch (error) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 迁移失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  migrateRemoveLocationFromSearch,
};
