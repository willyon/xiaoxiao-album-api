/*
 * @Description: 自动修复 media_analysis 中「未完成」的记录
 *               （analysis_status IN ('failed','pending') 且 analyzed_at IS NULL）
 *               重置状态并重新入队 mediaAnalysisQueue
 * @Usage:
 *   node scripts/tmp-scripts/reenqueue-media-analysis.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { mediaAnalysisQueue } = require(path.join(projectRoot, "src", "queues", "mediaAnalysisQueue"));

function getFailedMedia() {
  const stmt = db.prepare(
    `
    SELECT m.id, m.user_id, m.high_res_storage_key, m.original_storage_key, m.media_type
    FROM media_analysis ma
    JOIN media m ON m.id = ma.media_id
    WHERE ma.analysis_status IN ('failed','pending')
      AND ma.analyzed_at IS NULL
      AND m.deleted_at IS NULL
  `,
  );
  return stmt.all();
}

function resetMediaAnalysis(ids) {
  const tx = db.transaction(() => {
    const stmt = db.prepare(
      `
      UPDATE media_analysis
      SET
        analysis_status = 'pending',
        analysis_version = '1.0',
        analyzed_at = NULL,
        last_error = NULL,
        last_error_at = NULL
      WHERE media_id = ?
    `,
    );
    for (const id of ids) {
      stmt.run(id);
    }
  });
  tx();
}

async function main() {
  const rows = getFailedMedia();
  if (!rows.length) {
    // eslint-disable-next-line no-console
    console.log("没有找到 analysis_status='failed' 的 media 记录，无需处理。");
    process.exit(0);
  }

  resetMediaAnalysis(rows.map((r) => r.id));

  for (const row of rows) {
    const mediaType = row.media_type || "image";
    await mediaAnalysisQueue.add(
      "media-analysis",
      {
        imageId: row.id,
        userId: row.user_id,
        highResStorageKey: row.high_res_storage_key,
        originalStorageKey: row.original_storage_key,
        mediaType,
      },
      { jobId: `analysis:${row.user_id}:${row.id}` },
    );
  }

  // eslint-disable-next-line no-console
  console.log(`已重置并重新入队 ${rows.length} 条 media 记录:`, rows.map((r) => r.id));
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("执行失败:", err);
  process.exit(1);
});

