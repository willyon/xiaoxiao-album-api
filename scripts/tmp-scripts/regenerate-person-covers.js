/*
 * 重新生成人物封面图（按聚类恢复默认封面）
 *
 * 用途：
 * - 修复 face_thumbnail_storage_key 指向文件丢失导致的人物无封面
 * - 调用现有 restoreDefaultCover 流程，自动兜底生成缺失缩略图
 *
 * 用法：
 * - 全量执行：node scripts/tmp-scripts/regenerate-person-covers.js
 * - 指定用户：node scripts/tmp-scripts/regenerate-person-covers.js --userId=1
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
} = require(path.join(projectRoot, "src", "services", "faceClusterService"));

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const [k, v] = token.slice(2).split("=");
    args[k] = v == null ? true : v;
  }
  return args;
}

function getTargetClusters(userId) {
  const baseSql = `
    SELECT DISTINCT fc.user_id AS userId, fc.cluster_id AS clusterId
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE m.deleted_at IS NULL
  `;
  const orderSql = ` ORDER BY fc.user_id ASC, fc.cluster_id ASC`;

  if (userId == null) {
    return db.prepare(baseSql + orderSql).all();
  }
  return db.prepare(baseSql + ` AND fc.user_id = ?` + orderSql).all(Number(userId));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.userId != null ? Number(args.userId) : null;

  if (args.userId != null && !Number.isFinite(userId)) {
    throw new Error(`非法参数 --userId=${args.userId}`);
  }

  const rows = getTargetClusters(userId);
  if (rows.length === 0) {
    console.log("没有需要处理的人物聚类");
    return;
  }

  console.log(`待处理聚类数: ${rows.length}${userId != null ? ` (userId=${userId})` : ""}\n`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const idx = i + 1;

    try {
      const result = await restoreDefaultCover(row.userId, row.clusterId);
      if (!result) {
        skipped++;
        console.log(`[${idx}/${rows.length}] ⚠️ 跳过 user=${row.userId}, cluster=${row.clusterId}（无可用默认封面）`);
        continue;
      }

      const regeneratedKey = await generateThumbnailForFaceEmbedding(result.faceEmbeddingId, true);
      if (!regeneratedKey) {
        failed++;
        console.log(
          `[${idx}/${rows.length}] ❌ user=${row.userId}, cluster=${row.clusterId}, faceEmbeddingId=${result.faceEmbeddingId}（强制重建失败）`
        );
        continue;
      }

      success++;
      console.log(
        `[${idx}/${rows.length}] ✅ user=${row.userId}, cluster=${row.clusterId}, faceEmbeddingId=${result.faceEmbeddingId}`
      );
    } catch (error) {
      failed++;
      console.error(
        `[${idx}/${rows.length}] ❌ user=${row.userId}, cluster=${row.clusterId}: ${error.message}`
      );
    }
  }

  console.log("\n处理完成:");
  console.log(`- 成功: ${success}`);
  console.log(`- 跳过: ${skipped}`);
  console.log(`- 失败: ${failed}`);
}

main().catch((error) => {
  console.error("脚本执行失败:", error.message);
  process.exit(1);
});

