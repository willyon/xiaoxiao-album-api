/**
 * 批量将现有 media_search 文本转换为 visual_text 向量并写入 media_embeddings。
 *
 * 用法：
 *   node scripts/tmp-scripts/rebuild-visual-text-embeddings.js
 *   node scripts/tmp-scripts/rebuild-visual-text-embeddings.js --userId=1
 *   node scripts/tmp-scripts/rebuild-visual-text-embeddings.js --userId=1 --limit=500 --offset=0
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableMediaEmbeddings } = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { rebuildMediaEmbeddingDoc } = require(path.join(projectRoot, "src", "services", "mediaEmbeddingRebuildService"));

function parseArgs(argv) {
  const options = {
    userId: null,
    limit: null,
    offset: 0,
  };
  for (const arg of argv) {
    if (arg.startsWith("--userId=")) {
      const value = Number(arg.slice("--userId=".length));
      options.userId = Number.isFinite(value) ? value : null;
    } else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      options.limit = Number.isFinite(value) && value > 0 ? value : null;
    } else if (arg.startsWith("--offset=")) {
      const value = Number(arg.slice("--offset=".length));
      options.offset = Number.isFinite(value) && value >= 0 ? value : 0;
    }
  }
  return options;
}

function listMediaIds({ userId, limit, offset }) {
  const where = ["i.deleted_at IS NULL"];
  const params = [];
  if (userId != null) {
    where.push("i.user_id = ?");
    params.push(userId);
  }
  let sql = `
    SELECT ms.media_id AS media_id
    FROM media_search ms
    JOIN media i ON i.id = ms.media_id
    WHERE ${where.join(" AND ")}
    ORDER BY ms.media_id ASC
  `;
  if (limit != null) {
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);
  }
  return db.prepare(sql).pluck().all(...params);
}

async function rebuildVisualTextEmbeddings() {
  const options = parseArgs(process.argv.slice(2));
  console.log("🚀 开始重建 visual_text 向量...", options);

  createTableMediaEmbeddings();
  const mediaIds = listMediaIds(options);
  console.log(`📦 待处理媒体数: ${mediaIds.length}`);

  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  const progressEvery = 100;

  for (let i = 0; i < mediaIds.length; i += 1) {
    const mediaId = mediaIds[i];
    const result = await rebuildMediaEmbeddingDoc(mediaId);
    if (result.deleted) deleted += 1;
    else if (result.skipped) skipped += 1;
    else updated += 1;

    const n = i + 1;
    if (n % progressEvery === 0 || n === mediaIds.length) {
      console.log(`   … 进度 ${n}/${mediaIds.length}`);
    }
  }

  console.log("✅ visual_text 向量重建完成");
  console.log(`   - 更新条数: ${updated}`);
  console.log(`   - 删除条数: ${deleted}`);
  console.log(`   - 跳过条数: ${skipped}`);
}

if (require.main === module) {
  rebuildVisualTextEmbeddings().catch((error) => {
    console.error("❌ visual_text 向量重建失败:", error.message);
    process.exit(1);
  });
}

module.exports = {
  rebuildVisualTextEmbeddings,
};
