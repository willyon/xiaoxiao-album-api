/**
 * 对指定搜索词调用与线上一致的 searchMediaResults，打印每条结果的 Description/OCR，
 * 并用简单规则统计「与查询语义」的大致匹配程度（便于人工对照，非模型裁判）。
 *
 * Usage:
 *   node scripts/tmp-scripts/test-search-query-relevance.js
 *   node scripts/tmp-scripts/test-search-query-relevance.js --query="宝宝一个人玩耍" --userId=1 --pageSize=30
 *
 * 环境变量：SEARCH_TEST_USER_ID（未传 --userId 时使用）
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { clearSearchRankCache } = require(path.join(projectRoot, "src", "utils", "searchRankCacheStore"));
const searchService = require(path.join(projectRoot, "src", "services", "searchService"));

function parseArgs(argv) {
  const options = {
    query: "宝宝一个人玩耍",
    userId: null,
    pageNo: 1,
    pageSize: 50,
  };
  for (const arg of argv) {
    if (arg.startsWith("--query=")) options.query = arg.slice("--query=".length).trim();
    else if (arg.startsWith("--userId=")) {
      const v = Number(arg.slice("--userId=".length));
      options.userId = Number.isFinite(v) ? v : null;
    } else if (arg.startsWith("--pageNo=")) {
      const v = parseInt(arg.slice("--pageNo=".length), 10);
      if (Number.isFinite(v) && v > 0) options.pageNo = v;
    } else if (arg.startsWith("--pageSize=")) {
      const v = parseInt(arg.slice("--pageSize=".length), 10);
      if (Number.isFinite(v) && v > 0) options.pageSize = v;
    }
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

/**
 * 针对「宝宝 / 玩耍 / 独自」类查询的粗粒度相关性（字面 + 少量同义），仅作脚本统计用。
 * @returns {"strong"|"medium"|"weak"|"none"}
 */
function classifyRelevance(query, combinedText) {
  const t = String(combinedText || "");
  if (!t.trim()) return "none";

  const baby = /宝宝|婴儿|婴幼儿|小孩|儿童|幼儿|宝贝|^宝[^妈]|娃娃/.test(t);
  const play = /玩耍|玩乐|玩|游戏|玩具/.test(t);
  const alone =
    /一个人|独自|单独|自己|一人|单人|没有旁人|无其他人|爸妈不在|家长不在/.test(t) ||
    (/玩/.test(t) && /自己|独自|一个人/.test(t));

  const score = [baby, play, alone].filter(Boolean).length;
  if (score >= 3) return "strong";
  if (score === 2) return "medium";
  if (score === 1) return "weak";
  return "none";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const userId = resolveUserId(options.userId);
  if (userId == null) {
    console.error("无法解析 userId：请设置 SEARCH_TEST_USER_ID 或传入 --userId=");
    process.exit(1);
  }

  clearSearchRankCache();

  console.log("查询:", JSON.stringify(options.query));
  console.log("userId:", userId, "pageNo:", options.pageNo, "pageSize:", options.pageSize);
  console.log("---");

  const searchResult = await searchService.searchMediaResults({
    userId,
    query: options.query,
    baseFilters: {},
    filterOptions: { userId, clusterId: null },
    scopeConditions: [],
    scopeParams: [],
    pageNo: options.pageNo,
    pageSize: options.pageSize,
  });

  const stats = searchResult.stats || {};
  console.log(
    "搜索统计 termCount:",
    stats.termCount,
    "ftsCount:",
    stats.ftsCount,
    "ocrCount:",
    stats.ocrCount,
    "semanticCount:",
    stats.semanticCount,
  );
  console.log("total:", searchResult.total, "本页条数:", searchResult.list?.length ?? 0);
  console.log("==========\n");

  const list = searchResult.list || [];
  const counts = { strong: 0, medium: 0, weak: 0, none: 0 };

  list.forEach((item, index) => {
    const desc = item.aiDescription != null ? String(item.aiDescription) : "";
    const ocr = item.aiOcr != null ? String(item.aiOcr) : "";
    const combined = `${desc}\n${ocr}`;
    const tier = classifyRelevance(options.query, combined);
    counts[tier] += 1;

    console.log(`#${index + 1} mediaId=${item.mediaId} 相关性(规则): ${tier}`);
    console.log(`  aiDescription: ${desc.slice(0, 400)}${desc.length > 400 ? "…" : ""}`);
    if (ocr.trim()) console.log(`  aiOcr: ${ocr.slice(0, 200)}${ocr.length > 200 ? "…" : ""}`);
    console.log("");
  });

  const relevant = counts.strong + counts.medium;
  const somewhat = counts.weak;
  console.log("==========");
  console.log("规则统计（仅供参考）:");
  console.log("  strong :", counts.strong);
  console.log("  medium :", counts.medium);
  console.log("  weak   :", counts.weak);
  console.log("  none   :", counts.none);
  console.log(`→ 较符合（strong+medium）: ${relevant} / ${list.length}`);
  console.log(`→ 弱相关（weak）: ${somewhat} / ${list.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
