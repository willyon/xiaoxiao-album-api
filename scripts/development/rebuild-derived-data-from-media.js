/**
 * 清空基于 media 的派生表数据（仅删除数据，不重建）：
 * - 相似图分组：similar_groups / similar_group_members
 * - 人脸代表图：face_cluster_representatives
 * - 搜索相关：media_search / media_search_terms / media_search_fts
 *
 * 使用方式（在项目根目录）：
 *   node scripts/development/rebuild-derived-data-from-media.js
 *
 * 说明：
 * - 只做一件事：清空上述表中的数据（不动 users / media 本身）
 * - 若需要重建，可另行调用现有脚本/服务：
 *   - 相似图：scripts/development/rebuild-similar-groups.js
 *   - 搜索：使用 mediaModel.rebuildMediaSearchDoc 等
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function clearDerivedTables() {
  console.log("🧹 开始清空派生表数据（不动 users / media 本身）...");

  const tables = [
    // 相似图分组
    "similar_group_members",
    "similar_groups",
    // 人脸代表图
    "face_cluster_representatives",
    // 搜索物化表
    "media_search_terms",
    "media_search_fts",
    "media_search",
  ];

  db.prepare("BEGIN").run();
  try {
    for (const name of tables) {
      if (!tableExists(name)) continue;
      const changes = db.prepare(`DELETE FROM ${name}`).run().changes;
      console.log(`   - 清空表 ${name}，删除 ${changes} 行`);
    }
    db.prepare("COMMIT").run();
    console.log("✅ 派生表数据清空完成\n");
  } catch (error) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 清空派生表数据失败：", error.message);
    throw error;
  }
}

function tableExists(name) {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null
  );
}

async function main() {
  console.log("==============================================");
  console.log("📦 清空基于 media 的派生表数据（不做重建）");
  console.log("   - 清空 similar_groups / similar_group_members");
  console.log("   - 清空 face_cluster_representatives");
  console.log("   - 清空 media_search / media_search_terms / media_search_fts");
  console.log("==============================================\n");

  clearDerivedTables();
  console.log("🎉 派生表数据已全部清空！");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ 重建派生数据脚本执行失败：", error);
    process.exit(1);
  });

