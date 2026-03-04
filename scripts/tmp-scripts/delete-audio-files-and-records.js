/*
 * 删除所有音频文件及其数据库记录（含存储文件、album_images 等关联）
 * 用于重新上传原始文件前清空现有转码后的音频
 *
 * @Usage: node scripts/tmp-scripts/delete-audio-files-and-records.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const trashService = require(path.join(projectRoot, "src", "services", "trashService"));

async function main() {
  const rows = db
    .prepare(
      `SELECT id, user_id FROM images
       WHERE media_type = 'audio' AND deleted_at IS NULL`
    )
    .all();

  if (rows.length === 0) {
    console.log("没有需要删除的音频");
    return;
  }

  console.log(`共 ${rows.length} 个音频待删除\n`);

  // 按 user_id 分组
  const byUser = {};
  for (const r of rows) {
    if (!byUser[r.user_id]) byUser[r.user_id] = [];
    byUser[r.user_id].push(r.id);
  }

  // 1. 软删除（移至回收站状态）
  const now = Date.now();
  db.prepare(
    `UPDATE images SET deleted_at = ? WHERE media_type = 'audio' AND deleted_at IS NULL`
  ).run(now);
  console.log("已标记为回收站状态");

  // 2. 按用户彻底删除（删除存储文件 + 物理删除 DB）
  for (const [userId, imageIds] of Object.entries(byUser)) {
    try {
      const result = await trashService.permanentlyDeleteImages({
        userId: parseInt(userId, 10),
        imageIds,
      });
      console.log(`用户 ${userId}: 彻底删除 ${imageIds.length} 个音频`);
    } catch (err) {
      console.error(`用户 ${userId} 删除失败: ${err.message}`);
      throw err;
    }
  }

  console.log("\n完成：所有音频文件及数据库记录已删除");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
