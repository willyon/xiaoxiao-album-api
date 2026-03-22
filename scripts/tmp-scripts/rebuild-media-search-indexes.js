/**
 * 批量重建 media_search / media_search_terms / media_search_fts。
 * 用于搜索 schema 升级后，为历史媒体重新物化搜索文档。
 *
 * 用法：
 *   node scripts/tmp-scripts/rebuild-media-search-indexes.js
 *   node scripts/tmp-scripts/rebuild-all-media-search-docs.js   （同上，全量别名）
 *   node scripts/tmp-scripts/rebuild-media-search-indexes.js --userId=1
 *   node scripts/tmp-scripts/rebuild-media-search-indexes.js --userId=1 --limit=500
 *
 * 无 --limit 时对「未删除」的 media 全量重建 media_search / media_search_terms / FTS。
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  createTableMediaSearch,
  createTableMediaSearchFts,
  createTableMediaSearchTerms,
} = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { rebuildMediaSearchDoc } = require(path.join(projectRoot, "src", "models", "mediaModel"));

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
  const conditions = ["deleted_at IS NULL"];
  const params = [];

  if (userId != null) {
    conditions.push("user_id = ?");
    params.push(userId);
  }

  let sql = `
    SELECT id
    FROM media
    WHERE ${conditions.join(" AND ")}
    ORDER BY id ASC
  `;

  if (limit != null) {
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);
  }

  return db.prepare(sql).pluck().all(...params);
}

async function rebuildMediaSearchIndexes() {
  const options = parseArgs(process.argv.slice(2));
  console.log("🚀 开始重建搜索索引...", options);

  createTableMediaSearch();
  createTableMediaSearchTerms();
  createTableMediaSearchFts();

  const mediaIds = listMediaIds(options);
  console.log(`📦 待重建媒体数: ${mediaIds.length}`);

  let rebuiltCount = 0;
  let totalTermRows = 0;

  const progressEvery = 500;
  for (let i = 0; i < mediaIds.length; i++) {
    const mediaId = mediaIds[i];
    const result = rebuildMediaSearchDoc(mediaId);
    rebuiltCount += result.affectedRows > 0 ? 1 : 0;
    totalTermRows += result.termRows || 0;
    const n = i + 1;
    if (n % progressEvery === 0 || n === mediaIds.length) {
      console.log(`   … 进度 ${n}/${mediaIds.length}`);
    }
  }

  console.log("✅ 搜索索引重建完成");
  console.log(`   - 重建文档数: ${rebuiltCount}`);
  console.log(`   - term 行数: ${totalTermRows}`);
}

if (require.main === module) {
  rebuildMediaSearchIndexes().catch((error) => {
    console.error("❌ 搜索索引重建失败:", error.message);
    process.exit(1);
  });
}

module.exports = { rebuildMediaSearchIndexes };
