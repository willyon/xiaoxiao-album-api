/**
 * 在「与线上一致」的 where 与 residual 下，打印文本向量召回阶段每条 media 的 similarity（点积=余弦）。
 *
 * 与 searchService 中长句分支一致：query 文本为 parseQueryIntent 后的 residual，where 为全局搜索的 mergeScopeWhere([], [], buildSearchQueryParts(...))。
 *
 * Usage:
 *   node scripts/tmp-scripts/debug-visual-text-similarities.js
 *   node scripts/tmp-scripts/debug-visual-text-similarities.js --query="宝宝看医生" --userId=1
 *   node scripts/tmp-scripts/debug-visual-text-similarities.js --showBelow  # 同时打印低于阈值的行
 *
 * 环境变量：与 searchService 相同 VISUAL_EMBEDDING_MIN_SIMILARITY；SEARCH_TEST_USER_ID
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { parseQueryIntent, mergeFilters } = require(path.join(projectRoot, "src", "utils", "queryIntentParser"));
const { buildSearchQueryParts } = require(path.join(projectRoot, "src", "utils", "buildSearchQueryParts"));
const { generateTextEmbeddingForQuery } = require(path.join(projectRoot, "src", "services", "embeddingProvider"));
const { listVisualTextEmbeddingRowsForRecall } = require(path.join(projectRoot, "src", "models", "mediaEmbeddingModel"));

const _minSimParsed = parseFloat(process.env.VISUAL_EMBEDDING_MIN_SIMILARITY);
const VISUAL_EMBEDDING_MIN_SIMILARITY = Math.min(1, Math.max(0, Number.isFinite(_minSimParsed) ? _minSimParsed : 0.82));

function dotProduct(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let score = 0;
  for (let i = 0; i < a.length; i += 1) {
    score += (Number(a[i]) || 0) * (Number(b[i]) || 0);
  }
  return score;
}

function mergeScopeWhere(scopeConditions, scopeParams, built) {
  return {
    whereConditions: [...(scopeConditions || []), ...built.whereConditions],
    whereParams: [...(scopeParams || []), ...built.whereParams],
  };
}

function parseArgs(argv) {
  const options = {
    query: "宝宝看医生",
    userId: null,
    showBelow: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--query=")) options.query = arg.slice("--query=".length).trim();
    else if (arg.startsWith("--userId=")) {
      const v = Number(arg.slice("--userId=".length));
      options.userId = Number.isFinite(v) ? v : null;
    } else if (arg === "--showBelow") options.showBelow = true;
  }
  return options;
}

function resolveUserId(explicit) {
  if (explicit != null) return explicit;
  const fromEnv = process.env.SEARCH_TEST_USER_ID;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n)) return n;
  }
  const row = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
  if (row && row.id != null) return row.id;
  const m = db.prepare("SELECT DISTINCT user_id AS uid FROM media WHERE deleted_at IS NULL ORDER BY user_id ASC LIMIT 1").get();
  return m && m.uid != null ? m.uid : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const userId = resolveUserId(options.userId);
  if (userId == null) {
    console.error("无法解析 userId：请传 --userId= 或设置 SEARCH_TEST_USER_ID");
    process.exit(1);
  }

  const segment = String(options.query || "").trim();
  if (!segment) {
    console.error("query 为空");
    process.exit(1);
  }

  const parsedIntent = parseQueryIntent(segment);
  const mergedFilters = mergeFilters({}, parsedIntent);
  const built = buildSearchQueryParts("*", mergedFilters, { userId, clusterId: null });
  const { whereConditions: wc, whereParams: wp } = mergeScopeWhere([], [], built);
  const residual = String(parsedIntent.residualQuery || "").trim();

  console.log("=== 与线上一致的关键参数 ===");
  console.log("userId:", userId);
  console.log("整句 segment:", JSON.stringify(segment));
  console.log("语义向量用的 residual:", JSON.stringify(residual));
  console.log("VISUAL_EMBEDDING_MIN_SIMILARITY:", VISUAL_EMBEDDING_MIN_SIMILARITY);
  console.log("whereConditions 条数:", wc.length);
  if (wc.length) console.log("whereConditions:", wc);
  console.log("");

  if (!residual) {
    console.log("residual 为空，长句分支下不会对整句做文本向量查询（与线上一致）。");
    process.exit(0);
  }

  const queryVector = await generateTextEmbeddingForQuery(residual);
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    console.error("查询向量为空");
    process.exit(1);
  }

  const rows = listVisualTextEmbeddingRowsForRecall({
    userId,
    whereConditions: wc,
    whereParams: wp,
  });

  const scored = [];
  for (const row of rows) {
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const similarity = dotProduct(queryVector, row.vector || []);
    if (!Number.isFinite(similarity)) continue;
    scored.push({ media_id: mediaId, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity || b.media_id - a.media_id);

  const pass = scored.filter((r) => r.similarity >= VISUAL_EMBEDDING_MIN_SIMILARITY);
  const below = scored.filter((r) => r.similarity < VISUAL_EMBEDDING_MIN_SIMILARITY);

  console.log("=== 统计 ===");
  console.log("库内 visual_text 行数（本次 where 范围内）:", rows.length);
  console.log("有效向量条数（维度一致算完 similarity）:", scored.length);
  console.log("≥ 阈值（进入合并打分，与 recall 阶段一致）:", pass.length);
  console.log("< 阈值:", below.length);
  console.log("");

  const toPrint = options.showBelow ? scored : pass;
  console.log(`=== 明细（${options.showBelow ? "全部按 similarity 降序" : "仅 ≥ 阈值"}）===`);
  toPrint.forEach((r, i) => {
    const flag = r.similarity >= VISUAL_EMBEDDING_MIN_SIMILARITY ? "Y" : "N";
    console.log(`${String(i + 1).padStart(4)}  media_id=${r.media_id}  similarity=${r.similarity.toFixed(6)}  ≥阈值=${flag}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
