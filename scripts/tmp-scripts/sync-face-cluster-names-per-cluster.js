/**
 * 一次性维护：将同一 (user_id, cluster_id) 下 face_clusters 各行的 name 统一为「该簇内任意非空名」。
 *
 * 背景：name 冗余存每行，部分更新只改了部分行，会导致列表旧逻辑 GROUP BY cluster_id,name 出现同一人物两行。
 * 应用层已改为只按 cluster_id 聚合；本脚本用于把历史数据对齐，避免其它 SQL/排查混淆。
 *
 * 用法（项目根目录为 xiaoxiao-project-service）：
 *   node scripts/tmp-scripts/sync-face-cluster-names-per-cluster.js
 *   node scripts/tmp-scripts/sync-face-cluster-names-per-cluster.js --dry-run
 *   node scripts/tmp-scripts/sync-face-cluster-names-per-cluster.js --userId=1
 */

const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
process.chdir(projectRoot);
require("dotenv").config({ path: path.join(projectRoot, ".env") });

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  let userId = null;
  const u = process.argv.find((a) => a.startsWith("--userId="));
  if (u) {
    const n = parseInt(u.split("=")[1], 10);
    if (!Number.isNaN(n)) userId = n;
  }
  return { dryRun, userId };
}

function main() {
  const { dryRun, userId } = parseArgs();

  const clusters = db
    .prepare(
      `
    SELECT DISTINCT user_id, cluster_id
    FROM face_clusters
    ${userId != null ? "WHERE user_id = ?" : ""}
    ORDER BY user_id, cluster_id
  `,
    )
    .all(userId != null ? userId : []);

  let updatedRows = 0;
  let touchedGroups = 0;

  const selectName = db.prepare(`
    SELECT name FROM face_clusters
    WHERE user_id = ? AND cluster_id = ?
      AND name IS NOT NULL AND length(trim(name)) > 0
    LIMIT 1
  `);

  const updateStmt = db.prepare(`
    UPDATE face_clusters
    SET name = ?, updated_at = ?
    WHERE user_id = ? AND cluster_id = ?
  `);

  const tx = db.transaction(() => {
    const now = Date.now();
    for (const { user_id, cluster_id } of clusters) {
      const row = selectName.get(user_id, cluster_id);
      const canonical = row?.name != null ? String(row.name).trim() : null;
      const cur = db
        .prepare(
          `
        SELECT COUNT(*) AS c FROM face_clusters
        WHERE user_id = ? AND cluster_id = ?
          AND (name IS DISTINCT FROM ?)
      `,
        )
        .get(user_id, cluster_id, canonical);

      if (cur.c > 0) {
        touchedGroups++;
        if (!dryRun) {
          const r = updateStmt.run(canonical, now, user_id, cluster_id);
          updatedRows += r.changes;
        } else {
          updatedRows += cur.c;
        }
      }
    }
  });

  tx();

  console.log(
    dryRun
      ? `[dry-run] 将统一名称的 (user,cluster) 组数: ${touchedGroups}，涉及行约: ${updatedRows}（未写入）`
      : `已统一名称的组数: ${touchedGroups}，更新行数: ${updatedRows}`,
  );
}

main();
