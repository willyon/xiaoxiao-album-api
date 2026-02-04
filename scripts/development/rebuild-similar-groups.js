/*
 * 全量重建相似图分组（清理页「相似图」tab 数据来源）
 * - 从 images 表读取当前用户的所有未删除图片，按 image_phash 计算相似分组，写入 similar_groups / similar_group_members
 * - 定时任务：ecosystem.config.js 中配置为每天凌晨 3 点执行 (cron: "0 3 * * *")
 * - 手动执行：在项目根目录下执行 node scripts/development/rebuild-similar-groups.js
 */
require("dotenv").config();

const { db } = require("../../src/services/database");
const cleanupGroupingService = require("../../src/services/cleanupGroupingService");

function getAllUserIds() {
  const rows = db.prepare("SELECT id FROM users ORDER BY id").all();
  return rows.map((r) => r.id);
}

async function main() {
  console.log("[cleanupRebuildAll] 开始全量重建相似图分组...\n");

  // 清理孤儿成员（group_id 在 similar_groups 中不存在的记录，避免历史脏数据）
  const deleteOrphan = db.prepare(`
    DELETE FROM similar_group_members WHERE group_id NOT IN (SELECT id FROM similar_groups)
  `);
  const orphanResult = deleteOrphan.run();
  if (orphanResult.changes > 0) {
    console.log(`[cleanupRebuildAll] 已清理孤儿成员记录: ${orphanResult.changes} 条\n`);
  }

  const userIds = getAllUserIds();
  if (userIds.length === 0) {
    console.log("[cleanupRebuildAll] 未找到任何用户，退出");
    process.exit(0);
  }

  console.log(`[cleanupRebuildAll] 共 ${userIds.length} 个用户，将依次重建相似图分组。\n`);

  let totalGroups = 0;
  for (const userId of userIds) {
    try {
      const summary = cleanupGroupingService.rebuildCleanupGroups({ userId });
      const count = summary?.similarGroupCount ?? 0;
      totalGroups += count;
      console.log(`[cleanupRebuildAll] user_id=${userId} 完成，相似图分组数: ${count}`);
    } catch (err) {
      console.error(`[cleanupRebuildAll] user_id=${userId} 失败:`, err.message);
    }
  }

  console.log(`\n[cleanupRebuildAll] 全部完成，共生成相似图分组数: ${totalGroups}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[cleanupRebuildAll] 执行异常:", err);
  process.exit(1);
});
