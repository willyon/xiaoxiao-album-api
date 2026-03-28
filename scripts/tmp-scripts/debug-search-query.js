/**
 * 模拟前端 POST /search/media 的关键词搜索（与 handleSearchMedias 全局搜索路径一致），
 * 逐步打印：整句查询（与线上一致：不按空格拆段）、意图解析、长短分支、jieba 归一化后的 FTS 字符串、OCR/视觉 FTS 召回行数、最终 total。
 *
 * @Usage:
 *   node scripts/tmp-scripts/debug-search-query.js
 *   node scripts/tmp-scripts/debug-search-query.js --userId=1 --query=宝宝洗澡
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { clearSearchRankCache } = require(path.join(projectRoot, "src", "utils", "searchRankCacheStore"));
const { parseQueryIntent, mergeFilters } = require(path.join(projectRoot, "src", "utils", "queryIntentParser"));
const { buildSearchQueryParts } = require(path.join(projectRoot, "src", "utils", "buildSearchQueryParts"));
const {
  buildChineseQueryTerms,
  containsChinese,
  normalizeQueryForFts,
} = require(path.join(projectRoot, "src", "utils", "searchTermUtils"));
const searchModel = require(path.join(projectRoot, "src", "models", "searchModel"));
const searchService = require(path.join(projectRoot, "src", "services", "searchService"));
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { getCoreTokensOnlyForResidual } = require(path.join(projectRoot, "src", "utils", "embeddingLexicalGate"));

// 与 searchService.js 保持一致（用于打印与直连 FTS 校验）
function sanitizeFtsToken(token) {
  const value = String(token || "").trim();
  if (!value) return "";
  if (/^[\p{L}\p{N}_\u3400-\u9fff*]+$/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function buildFtsQueryForToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const preprocessed = containsChinese(raw) ? normalizeQueryForFts(raw) : raw;
  const tokens = preprocessed.split(/\s+/).map(sanitizeFtsToken).filter(Boolean);
  return tokens.length > 0 ? tokens.join(" ") : null;
}

const VISUAL_FTS5_COLUMN_GROUP =
  "{description_text keywords_text subject_tags_text action_tags_text scene_tags_text transcript_text caption_search_terms}";

function wrapFtsQueryForVisualColumnsOnly(innerQuery) {
  const inner = String(innerQuery || "").trim();
  if (!inner) return null;
  return `${VISUAL_FTS5_COLUMN_GROUP} : (${inner})`;
}

function wrapFtsQueryForOcrColumnOnly(innerQuery) {
  const inner = String(innerQuery || "").trim();
  if (!inner) return null;
  return `{ocr_search_terms} : (${inner})`;
}

function segmentLengthUnits(segment) {
  const s = String(segment || "").trim();
  if (!s) return 0;
  const cjk = s.match(/[\u3400-\u9fff]/g);
  const cjkCount = cjk ? cjk.length : 0;
  const rest = s.replace(/[\u3400-\u9fff]/g, " ");
  const words = rest.trim().match(/[a-zA-Z0-9]+/g);
  const wordCount = words ? words.length : 0;
  return cjkCount + wordCount;
}

function mergeScopeWhere(scopeConditions, scopeParams, built) {
  return {
    whereConditions: [...(scopeConditions || []), ...built.whereConditions],
    whereParams: [...(scopeParams || []), ...built.whereParams],
  };
}

function parseArgs(argv) {
  let userId = process.env.DEBUG_SEARCH_USER_ID ? Number(process.env.DEBUG_SEARCH_USER_ID) : 1;
  let query = "宝宝洗澡";
  for (const arg of argv) {
    if (arg.startsWith("--userId=")) {
      const v = Number(arg.slice("--userId=".length));
      if (Number.isFinite(v)) userId = v;
    } else if (arg.startsWith("--query=")) {
      query = arg.slice("--query=".length);
    }
  }
  return { userId, query };
}

async function main() {
  const { userId, query } = parseArgs(process.argv.slice(2));

  console.log("========== 1. 入参（等同前端全局搜索）==========");
  console.log(`userId=${userId}`);
  console.log(`query=${JSON.stringify(query)}`);

  clearSearchRankCache();

  const filterOptions = { userId, clusterId: null };
  const baseFilters = {};

  const normalizedQuery = query.trim();
  const segments = normalizedQuery ? [normalizedQuery] : [];

  console.log("\n========== 2. 查询段（与 searchService 一致：整句一段，空格为句内多线索）==========");
  console.log("segments:", segments);

  console.log("\n========== 3. 每段的解析与 FTS 子串（通常仅一段）==========");

  for (let si = 0; si < segments.length; si++) {
    const segment = segments[si];
    const parsedIntent = parseQueryIntent(segment);
    const mergedFilters = mergeFilters(baseFilters, parsedIntent);
    const built = buildSearchQueryParts("*", mergedFilters, filterOptions);
    const { whereConditions: wc, whereParams: wp } = mergeScopeWhere([], [], built);

    const residual = (parsedIntent.residualQuery || "").trim();
    const hasStructured = Boolean(
      parsedIntent.filters?.timeDimension
      || parsedIntent.filters?.customDateRange
      || parsedIntent.filters?.location?.length,
    );
    const residualLenUnits = segmentLengthUnits(residual);
    const isLongBranch = residualLenUnits >= 3;
    const ocrLenUnits = segmentLengthUnits(segment);

    const coreVisualTokens = residual && residualLenUnits >= 3 ? getCoreTokensOnlyForResidual(residual) : [];
    const innerVisual =
      coreVisualTokens.length > 0
        ? coreVisualTokens.map(sanitizeFtsToken).filter(Boolean).join(" ") || null
        : null;
    const wrappedVisual = innerVisual ? wrapFtsQueryForVisualColumnsOnly(innerVisual) : null;
    const innerOcr = buildFtsQueryForToken(segment);
    const wrappedOcr = innerOcr ? wrapFtsQueryForOcrColumnOnly(innerOcr) : null;

    console.log(`\n--- segment[${si}] = ${JSON.stringify(segment)} ---`);
    console.log("parseQueryIntent.residualQuery:", JSON.stringify(residual));
    console.log("hasStructured (时间/地点等):", hasStructured);
    console.log(
      "residualLenUnits:",
      residualLenUnits,
      "→ 视觉：≤2 仅 term+同义词；≥3 内容词 FTS+向量（旧 isLongBranch）:",
      isLongBranch,
    );
    console.log("ocrLenUnits (整段 segment):", ocrLenUnits, "→ <3 走 OCR term 表，否则走 OCR FTS");

    console.log("\nbuildSearchQueryParts 产生的 WHERE 条件数:", wc.length);
    if (wc.length > 0) {
      console.log("whereConditions:", wc);
      console.log("whereParams:", wp);
    }

    console.log("\n[jieba 归一化后] normalizeQueryForFts(residual)（参考，长句视觉 FTS 已改用内容词）:", JSON.stringify(normalizeQueryForFts(residual)));
    console.log("getCoreTokensOnlyForResidual(residual) →", coreVisualTokens);
    console.log("视觉 FTS 括号内 inner（sanitize 后拼接）:", JSON.stringify(innerVisual));
    console.log("wrap 后完整视觉 MATCH 串:", wrappedVisual);

    console.log("\nbuildFtsQueryForToken(segment) → inner (OCR FTS 括号内):", JSON.stringify(innerOcr));
    console.log("wrap 后完整 OCR MATCH 串:", wrappedOcr);

    const termsResidual = buildChineseQueryTerms(residual);
    console.log(
      "\nbuildChineseQueryTerms(residual)（OCR 短句仍用；视觉 ≤2：中文仅用整段 trim+expandTermsWithSynonyms，不 jieba；非中文仍分词）:",
      termsResidual.map((t) => t.term),
    );

    if (wrappedVisual) {
      const visualRows = searchModel.recallMediaIdsByFts({
        userId,
        ftsQuery: wrappedVisual,
        whereConditions: wc,
        whereParams: wp,
      });
      console.log("\n>>> recallMediaIdsByFts(视觉列组) 行数:", visualRows.length);
      if (visualRows.length > 0) {
        console.log("    前 10 个 media_id:", visualRows.slice(0, 10).map((r) => r.media_id));
      }
    } else {
      console.log("\n>>> 视觉 FTS inner 为空，跳过 recallMediaIdsByFts");
    }

    if (wrappedOcr) {
      const ocrRows = searchModel.recallMediaIdsByOcrFts({
        userId,
        ftsQuery: wrappedOcr,
        whereConditions: wc,
        whereParams: wp,
      });
      console.log(">>> recallMediaIdsByOcrFts(OCR 列) 行数:", ocrRows.length);
      if (ocrRows.length > 0) {
        console.log("    前 10 个 media_id:", ocrRows.slice(0, 10).map((r) => r.media_id));
      }
    } else {
      console.log(">>> OCR FTS inner 为空，跳过 recallMediaIdsByOcrFts");
    }
  }

  console.log("\n========== 4. 数据侧抽样：该用户下 caption_search_terms 含「宝宝」且含「洗澡」的行数 ==========");
  try {
    const row = db
      .prepare(
        `
      SELECT COUNT(*) AS c
      FROM media_search ms
      JOIN media i ON i.id = ms.media_id
      WHERE i.user_id = ?
        AND i.deleted_at IS NULL
        AND ms.caption_search_terms IS NOT NULL
        AND INSTR(ms.caption_search_terms, '宝宝') > 0
        AND INSTR(ms.caption_search_terms, '洗澡') > 0
    `,
      )
      .get(userId);
    console.log("COUNT:", row?.c ?? 0);
  } catch (e) {
    console.log("查询失败:", e.message);
  }

  console.log("\n========== 5. 调用 searchService.searchMediaResults（与接口一致）==========");
  const result = await searchService.searchMediaResults({
    userId,
    query: normalizedQuery,
    baseFilters,
    filterOptions,
    scopeConditions: [],
    scopeParams: [],
    pageNo: 1,
    pageSize: 20,
  });
  console.log("total:", result.total);
  console.log("stats:", result.stats);
  console.log(
    "本页 mediaId 列表:",
    result.list.map((m) => m.mediaId),
  );

  console.log("\n========== 6. FTS 索引是否与内容一致（关键）==========");
  try {
    const sample = db
      .prepare(
        `
      SELECT ms.media_id
      FROM media_search ms
      JOIN media i ON i.id = ms.media_id
      WHERE i.user_id = ?
        AND i.deleted_at IS NULL
        AND ms.caption_search_terms IS NOT NULL
        AND INSTR(ms.caption_search_terms, '宝宝') > 0
        AND INSTR(ms.caption_search_terms, '洗澡') > 0
      LIMIT 1
    `,
      )
      .get(userId);
    if (sample?.media_id != null) {
      const mid = sample.media_id;
      const innerProbe = buildFtsQueryForToken(normalizedQuery);
      const wrappedProbe = innerProbe ? wrapFtsQueryForVisualColumnsOnly(innerProbe) : null;
      const matchBare = db
        .prepare("SELECT COUNT(*) AS c FROM media_search_fts WHERE rowid = ? AND media_search_fts MATCH ?")
        .get(mid, innerProbe || "宝宝");
      const matchWrapped = wrappedProbe
        ? db
            .prepare(
              `
          SELECT COUNT(*) AS c
          FROM media_search_fts
          JOIN media_search ms ON media_search_fts.rowid = ms.media_id
          JOIN media i ON ms.media_id = i.id
          WHERE i.user_id = ?
            AND i.deleted_at IS NULL
            AND ms.media_id = ?
            AND media_search_fts MATCH ?
        `,
            )
            .get(userId, mid, wrappedProbe)
        : { c: 0 };
      console.log(`抽样 media_id=${mid}（caption 中同时含「宝宝」「洗澡」）`);
      console.log(`  对整行 MATCH 查询词「${innerProbe || "宝宝"}」命中行数:`, matchBare.c);
      console.log(`  对「视觉列组」完整 MATCH 串在本行上命中行数:`, matchWrapped.c);
      if (matchBare.c === 0) {
        console.log(
          "\n  ⚠️ 判定：media_search 里已有 caption_search_terms 文本，但 FTS 倒排索引未命中（常见于索引未同步）。",
        );
        console.log(
          "     处理：在项目根执行 `node scripts/tmp-scripts/rebuild-media-search-indexes.js`，或在 sqlite 中执行：",
        );
        console.log("     INSERT INTO media_search_fts(media_search_fts) VALUES('rebuild');");
      }
    } else {
      console.log("无满足「caption 同时含宝宝与洗澡」的样本行，跳过 FTS 一致性检测。");
    }
  } catch (e) {
    console.log("第 6 步失败:", e.message);
  }

  console.log("\n========== 说明 ==========");
  console.log(
    "- 若第 3 步「视觉 FTS 行数」>0 但第 5 步 total=0：重点查排序/合并/缓存（本脚本已 clearSearchRankCache）。",
  );
  console.log(
    "- 若第 3 步视觉 FTS 行数=0 但第 4 步 COUNT>0：先看第 6 步；若第 6 步 MATCH 仍=0，多为 FTS 索引未 rebuild，与 jieba/caption_search_terms 内容无关。",
  );
  console.log("- OCR 路径只看 ocr_search_terms；关键词在 caption_search_terms 时，应依赖「视觉 FTS」这一路。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
