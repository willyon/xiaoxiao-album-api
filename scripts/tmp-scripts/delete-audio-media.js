/*
 * 一次性迁移：检查并物理删除 media_type = 'audio' 的历史数据
 * 重构后仅支持 image/video，audio 类型需清理。
 *
 * @Usage: node scripts/tmp-scripts/delete-audio-media.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function main() {
  // 1. 检查是否存在 media_type = 'audio' 的记录
  const countResult = db.prepare(`SELECT COUNT(*) as count FROM images WHERE media_type = 'audio'`).get();
  const count = countResult?.count ?? 0;

  if (count === 0) {
    console.log("✅ 数据库中无 media_type = 'audio' 的记录，无需处理");
    return;
  }

  console.log(`发现 ${count} 条 media_type = 'audio' 的记录，开始物理删除...`);

  // 2. 物理删除（外键 CASCADE 会自动清理 face_embeddings、image_embeddings、album_images、similar_group_members 等）
  const result = db.prepare(`DELETE FROM images WHERE media_type = 'audio'`).run();

  console.log(`✅ 已物理删除 ${result.changes} 条 audio 记录`);
}

main();
