/*
 * 回填 face_cluster_representatives：为当前所有 (user_id, cluster_id) 计算并写入代表向量
 * 适用场景：不想跑全量聚类，只希望新表有数据（用于后续增量分配）。
 * 执行 rebuild-face-clusters.js 时也会自动写入新 cluster 的代表向量，无需先跑本脚本。
 *
 * @Usage: node scripts/tmp-scripts/backfill-face-cluster-representatives.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { computeAndUpsertClusterRepresentative } = require(path.join(
  projectRoot,
  "src",
  "models",
  "faceClusterModel"
));

function getAllDistinctClusters() {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT user_id, cluster_id
    FROM face_clusters
    ORDER BY user_id, cluster_id
  `
    )
    .all();
  return rows;
}

function main() {
  const pairs = getAllDistinctClusters();
  if (pairs.length === 0) {
    console.log("当前没有任何人物聚类数据，无需回填");
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const { user_id, cluster_id } of pairs) {
    const result = computeAndUpsertClusterRepresentative(user_id, cluster_id);
    if (result.updated) updated += 1;
    else skipped += 1;
  }

  console.log(`✅ 回填完成：共 ${pairs.length} 个人物，已写入代表向量 ${updated} 个，无有效人脸跳过 ${skipped} 个`);
}

main();
