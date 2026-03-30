/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索业务逻辑服务
 */
const searchModel = require("../models/searchModel");
const { listVisualTextEmbeddingRowsForRecall } = require("../models/mediaEmbeddingModel");
const { makeSearchRankCacheKey, getSearchRankCache, setSearchRankCache } = require("../utils/searchRankCacheStore");
const { FTS_RANKING, SEARCH_TERM_FIELD_WEIGHTS, CHINESE_QUERY_TERM_BOOST } = require("../config/searchRankingWeights");
const { parseQueryIntent, mergeFilters } = require("../utils/queryIntentParser");
const { buildSearchQueryParts } = require("../utils/buildSearchQueryParts");
const { containsChinese, segmentLengthUnits } = require("../utils/searchTermUtils");
const { generateTextEmbeddingForQuery } = require("./embeddingProvider");
const { SEARCH_TERMS_SPLIT_REGEX } = require("../utils/chineseSegmenter");
const {
  passLexicalGate,
  getCoreTokensOnlyForResidual,
  isStopWordWholeSegment,
  extractActionGroups,
  calcRequiredGroupHits,
} = require("../utils/embeddingLexicalGate");
const { expandTermsWithSynonyms } = require("../utils/searchSynonymExpansion");
const { buildVisualEmbeddingGateLexicalSpec } = require("../utils/visualEmbeddingLexicalGate");

const _minSimParsed = parseFloat(process.env.VISUAL_EMBEDDING_MIN_SIMILARITY);
/** 与 query 向量点积（已归一化即余弦），低于则不进候选；默认 0.88，`.env` 的 VISUAL_EMBEDDING_MIN_SIMILARITY 覆盖 */
const VISUAL_EMBEDDING_MIN_SIMILARITY = Math.min(1, Math.max(0, Number.isFinite(_minSimParsed) ? _minSimParsed : 0.88));

const _topKParsed = parseInt(process.env.VISUAL_EMBEDDING_RECALL_TOP_K, 10);
/** 语义召回最多前 K 条；未设或无效则 null（不截断），`.env` 的 VISUAL_EMBEDDING_RECALL_TOP_K 设正整数可限制 */
const VISUAL_EMBEDDING_RECALL_TOP_K = Number.isFinite(_topKParsed) && _topKParsed > 0 ? _topKParsed : null;

const VISUAL_EMBEDDING_SCORE_SCALE = 120;

function sanitizeFtsToken(token) {
  const value = String(token || "").trim();
  if (!value) return "";
  if (/^[\p{L}\p{N}_\u3400-\u9fff*]+$/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** 长句视觉 FTS：已分好内容词时直接 sanitize 拼接，避免对整句再 jieba 一遍 */
function buildVisualFtsInnerFromCoreTokens(coreTokens) {
  const parts = (coreTokens || []).map((t) => sanitizeFtsToken(t)).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** 向量查询文本：仅使用 core tokens，空则不查向量。 */
function buildEmbeddingQueryFromCoreTokens(coreTokens) {
  const parts = (coreTokens || []).map((t) => String(t || "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** 图片理解 FTS：caption_search_terms 为 description/标签/转写等 jieba，不含 OCR；OCR 检索单独走 ocr_text LIKE。 */
const VISUAL_FTS5_COLUMN_GROUP =
  "{description_text keywords_text subject_tags_text action_tags_text scene_tags_text transcript_text caption_search_terms}";

function wrapFtsQueryForVisualColumnsOnly(innerQuery) {
  const inner = String(innerQuery || "").trim();
  if (!inner) return null;
  return `${VISUAL_FTS5_COLUMN_GROUP} : (${inner})`;
}

/** 用户输入 → LOWER 后对 SQLite LIKE 转义 % _ \\，再包前后 %（与 recallMediaIdsByOcrTextLike 的 ESCAPE '\\\\' 配合）。 */
function buildOcrTextLikePattern(segment) {
  const raw = String(segment || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const escaped = lower.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${escaped}%`;
}

// SQLite 单语句绑定变量有上限（常见为 999），大批量 id 的 IN 查询需分批。
const SQLITE_IN_CLAUSE_CHUNK = 900;

/**
 * 按 rankedIds 顺序从 offset 起凑满一页；跳过已删除/不可见的媒体，避免缓存命中后出现空洞。
 */
function buildOrderedPageMedias(userId, rankedIds, offset, pageSize) {
  const list = [];
  let readHead = offset;
  while (list.length < pageSize && readHead < rankedIds.length) {
    const remaining = rankedIds.length - readHead;
    const batchLen = Math.min(SQLITE_IN_CLAUSE_CHUNK, remaining, Math.max(pageSize - list.length + 24, pageSize));
    const batchIds = rankedIds.slice(readHead, readHead + batchLen);
    readHead += batchLen;
    const rows = fetchMediasByIdsChunked(userId, batchIds);
    const map = new Map(rows.map((item) => [item.mediaId, item]));
    for (const id of batchIds) {
      const row = map.get(id);
      if (row) {
        list.push(row);
        if (list.length >= pageSize) return list;
      }
    }
  }
  return list;
}

function fetchMediasByIdsChunked(userId, imageIds) {
  if (!imageIds.length) return [];
  const rows = [];
  for (let i = 0; i < imageIds.length; i += SQLITE_IN_CLAUSE_CHUNK) {
    rows.push(
      ...searchModel.getMediasByIds({
        userId,
        imageIds: imageIds.slice(i, i + SQLITE_IN_CLAUSE_CHUNK),
      }),
    );
  }
  return rows;
}

function ensureCandidate(candidates, mediaId) {
  if (!candidates.has(mediaId)) {
    candidates.set(mediaId, {
      mediaId,
      score: 0,
      chineseHits: 0,
      ftsRank: null,
      hasOcrMatch: false,
      /** 图片理解侧召回或结构化标签命中（非 OCR LIKE） */
      hasVisualMatch: false,
      visualSemanticScore: 0,
      matchedFields: new Set(),
      matchedTermsByField: new Map(),
      roleSignals: {
        subject: false,
        action: false,
        scene: false,
      },
    });
  }
  return candidates.get(mediaId);
}

/** media_search_terms 精确命中（短中文 1～2 字为主）；OCR 仅走 ocr_text LIKE，不入 terms 表。 */
function scoreChineseTermHits(termRows, queryTerms) {
  const candidates = new Map();
  const boostByTerm = new Map(queryTerms.map((item) => [item.term, item]));

  for (const row of termRows || []) {
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const queryTerm = boostByTerm.get(row.term);
    if (!queryTerm) continue;

    const candidate = ensureCandidate(candidates, mediaId);
    const fieldWeight = SEARCH_TERM_FIELD_WEIGHTS[row.field_type] || 40;
    candidate.score += fieldWeight + queryTerm.boost;
    candidate.chineseHits += 1;
    candidate.hasVisualMatch = true;
    candidate.matchedFields.add(row.field_type);
    if (!candidate.matchedTermsByField.has(row.field_type)) {
      candidate.matchedTermsByField.set(row.field_type, new Set());
    }
    candidate.matchedTermsByField.get(row.field_type).add(row.term);
  }

  return candidates;
}

function mergeFtsScores(candidates, ftsRows, hasChineseQuery) {
  const baseScore = hasChineseQuery ? FTS_RANKING.chineseBaseScore : FTS_RANKING.nonChineseBaseScore;
  for (let index = 0; index < (ftsRows || []).length; index += 1) {
    const row = ftsRows[index];
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.score += Math.max(FTS_RANKING.minScore, baseScore - index);
    candidate.ftsRank = index + 1;
    candidate.hasVisualMatch = true;
  }
}

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

function recallMediaIdsByVisualEmbedding({ userId, queryText, whereConditions, whereParams, topK } = {}) {
  const limit = topK !== undefined ? topK : VISUAL_EMBEDDING_RECALL_TOP_K;
  const text = String(queryText || "").trim();
  if (!text) {
    return [];
  }
  return generateTextEmbeddingForQuery(text).then((queryVector) => {
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      return [];
    }
    const rows = listVisualTextEmbeddingRowsForRecall({
      userId,
      whereConditions,
      whereParams,
    });
    const scored = [];
    for (const row of rows) {
      const mediaId = Number(row.media_id);
      if (!Number.isFinite(mediaId)) continue;
      const similarity = dotProduct(queryVector, row.vector || []);
      if (!Number.isFinite(similarity) || similarity < VISUAL_EMBEDDING_MIN_SIMILARITY) continue;
      scored.push({
        media_id: mediaId,
        similarity,
        description_text: row.description_text,
      });
    }
    scored.sort((a, b) => b.similarity - a.similarity || b.media_id - a.media_id);
    if (Number.isFinite(limit) && limit > 0) {
      return scored.slice(0, limit);
    }
    return scored;
  });
}

function mergeVisualSemanticScores(candidates, embeddingRows) {
  for (const row of embeddingRows || []) {
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const similarity = Number(row.similarity);
    if (!Number.isFinite(similarity)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.visualSemanticScore = Math.max(candidate.visualSemanticScore || 0, similarity);
    candidate.score += similarity * VISUAL_EMBEDDING_SCORE_SCALE;
    candidate.hasVisualMatch = true;
  }
}

function scoreOcrTextLikeHits(candidates, ocrRows) {
  for (const row of ocrRows || []) {
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.hasOcrMatch = true;
    candidate.score += SEARCH_TERM_FIELD_WEIGHTS.ocrLikeHit;
  }
}

/** 大类：双命中 > 仅 OCR > 仅图片理解 > 其它；同类内再比 score。 */
function candidateRankTier(c) {
  if (c.hasOcrMatch && c.hasVisualMatch) return 3;
  if (c.hasOcrMatch) return 2;
  if (c.hasVisualMatch) return 1;
  return 0;
}

function sortCandidates(candidates, mediaMap) {
  return Array.from(candidates.values()).sort((a, b) => {
    const tierA = candidateRankTier(a);
    const tierB = candidateRankTier(b);
    if (tierB !== tierA) {
      return tierB - tierA;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const mediaA = mediaMap.get(a.mediaId);
    const mediaB = mediaMap.get(b.mediaId);
    const capturedA = Number(mediaA?.capturedAt || 0);
    const capturedB = Number(mediaB?.capturedAt || 0);
    if (capturedB !== capturedA) {
      return capturedB - capturedA;
    }
    return b.mediaId - a.mediaId;
  });
}

/** 短句 terms：与 `chineseSegmenter` 分隔符一致，切段后多词 AND（每段内中文才做同义词扩展）。 */
function splitResidualSegmentsForShortTerms(residual) {
  const raw = String(residual || "").trim();
  if (!raw) return [];
  return raw
    .split(SEARCH_TERMS_SPLIT_REGEX)
    .map((s) => s.trim())
    .filter(Boolean);
}

function filterStopWordSegmentsForTerms(segments) {
  return (segments || []).filter((s) => s && !isStopWordWholeSegment(s));
}

/** 单段 → 同义词扩展后的 term 列表；仅中文扩展，英文/数字为小写单 token。 */
function expandSegmentTermsForChineseTermsAnd(residualSegment) {
  const seg = String(residualSegment || "").trim();
  if (!seg) return [];
  if (containsChinese(seg)) {
    return expandTermsWithSynonyms([seg]);
  }
  if (/^[\x00-\x7f]+$/.test(seg)) {
    return [seg.toLowerCase()];
  }
  return [seg];
}

function intersectMediaIdSets(a, b) {
  const out = new Set();
  for (const id of a) {
    if (b.has(id)) out.add(id);
  }
  return out;
}

function mergeScopeWhere(scopeConditions, scopeParams, built) {
  return {
    whereConditions: [...(scopeConditions || []), ...built.whereConditions],
    whereParams: [...(scopeParams || []), ...built.whereParams],
  };
}

function cloneCandidate(c) {
  const m = new Map();
  c.matchedTermsByField.forEach((set, k) => {
    m.set(k, new Set(set));
  });
  return {
    mediaId: c.mediaId,
    score: c.score,
    chineseHits: c.chineseHits,
    ftsRank: c.ftsRank,
    hasOcrMatch: c.hasOcrMatch,
    hasVisualMatch: Boolean(c.hasVisualMatch),
    matchedFields: new Set(c.matchedFields),
    matchedTermsByField: m,
    roleSignals: { ...c.roleSignals },
    visualSemanticScore: c.visualSemanticScore || 0,
  };
}

function mergeCandidateInto(target, src) {
  target.score += src.score;
  target.hasOcrMatch = target.hasOcrMatch || src.hasOcrMatch;
  target.hasVisualMatch = Boolean((target.hasVisualMatch ?? false) || (src.hasVisualMatch ?? false));
  target.chineseHits += src.chineseHits;
  for (const f of src.matchedFields) target.matchedFields.add(f);
  src.matchedTermsByField.forEach((set, key) => {
    if (!target.matchedTermsByField.has(key)) target.matchedTermsByField.set(key, new Set());
    set.forEach((term) => target.matchedTermsByField.get(key).add(term));
  });
  target.roleSignals.subject = target.roleSignals.subject || src.roleSignals.subject;
  target.roleSignals.action = target.roleSignals.action || src.roleSignals.action;
  target.roleSignals.scene = target.roleSignals.scene || src.roleSignals.scene;
  target.visualSemanticScore = Math.max(target.visualSemanticScore || 0, src.visualSemanticScore || 0);
}

function mergeCandidateMapsInto(global, segMap) {
  for (const [mediaId, cand] of segMap) {
    const id = Number(mediaId);
    if (!Number.isFinite(id)) continue;
    if (!global.has(id)) {
      global.set(id, cloneCandidate(cand));
    } else {
      mergeCandidateInto(global.get(id), cand);
    }
  }
}

/**
 * OCR：`segment` 按空白切分为多段，每段各自对 `ocr_text` 做 LOWER + LIKE；结果按 media_id **并集去重**（任一一段命中即纳入）。
 * 无空白时等价于整句一次 LIKE。英文不区分大小写。
 */
function applyOcrRecallForSegment({ segment, userId, whereConditions, whereParams }, segCands) {
  const trimmed = String(segment || "").trim();
  if (!trimmed) {
    return { likeRows: 0 };
  }
  const chunks = trimmed.split(/\s+/).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks) {
    const likePattern = buildOcrTextLikePattern(chunk);
    if (!likePattern) continue;
    const rows = searchModel.recallMediaIdsByOcrTextLike({
      userId,
      likePattern,
      whereConditions,
      whereParams,
    });
    for (const row of rows) {
      const mediaId = Number(row.media_id);
      if (!Number.isFinite(mediaId)) continue;
      if (!byId.has(mediaId)) {
        byId.set(mediaId, row);
      }
    }
  }
  const ocrRows = Array.from(byId.values());
  scoreOcrTextLikeHits(segCands, ocrRows);
  return { likeRows: ocrRows.length };
}

/**
 * 仅图片理解：筛选 / 视觉列 FTS / 向量（任意 residual 长度都走 FTS + embedding）；短句额外走 term + 同义词。
 */
async function applyVisualRecallForSegment({ segment, residual, hasStructured, userId, whereConditions, whereParams }, segCands) {
  let termRows = 0;
  let ftsRows = 0;
  let semanticRows = 0;

  if (!residual && hasStructured) {
    const filterRows = searchModel.recallMediaIdsByFiltersOnly({
      userId,
      whereConditions,
      whereParams,
    });
    mergeFtsScores(
      segCands,
      filterRows.map((r) => ({ media_id: r.media_id })),
      containsChinese(segment),
    );
    ftsRows += filterRows.length;
  } else if (residual) {
    const residualUnits = segmentLengthUnits(residual);

    if (residualUnits <= 2) {
      const segments = filterStopWordSegmentsForTerms(splitResidualSegmentsForShortTerms(residual));
      const groups = segments.map((s) => expandSegmentTermsForChineseTermsAnd(s)).filter((g) => g.length > 0);

      if (groups.length > 0) {
        let allowedIds = null;
        for (const terms of groups) {
          const rows = searchModel.recallMediaIdsByChineseTerms({
            userId,
            terms,
            whereConditions,
            whereParams,
          });
          const ids = new Set();
          for (const r of rows) {
            const mid = Number(r.media_id);
            if (Number.isFinite(mid)) ids.add(mid);
          }
          allowedIds = allowedIds === null ? ids : intersectMediaIdSets(allowedIds, ids);
          if (allowedIds.size === 0) break;
        }

        const allTermsFlat = [...new Set(groups.flat())];
        const queryTerms = allTermsFlat
          .map((term) => {
            const termLen = Array.from(term).length;
            const boost = termLen >= 2 ? CHINESE_QUERY_TERM_BOOST.multiChar : CHINESE_QUERY_TERM_BOOST.singleChar;
            return { term, termLen, boost };
          })
          .sort((a, b) => b.termLen - a.termLen || a.term.localeCompare(b.term, "zh-Hans-CN"));

        if (queryTerms.length > 0 && allowedIds && allowedIds.size > 0) {
          const termRowsDataAll = searchModel.recallMediaIdsByChineseTerms({
            userId,
            terms: queryTerms.map((item) => item.term),
            whereConditions,
            whereParams,
          });
          const termRowsData = termRowsDataAll.filter((r) => allowedIds.has(Number(r.media_id)));
          mergeCandidateMapsInto(segCands, scoreChineseTermHits(termRowsData, queryTerms));
          termRows += termRowsData.length;
        }
      }
    }

    const ftsCoreTokens = getCoreTokensOnlyForResidual(residual);
    const inner = buildVisualFtsInnerFromCoreTokens(ftsCoreTokens);
    const wrapped = inner ? wrapFtsQueryForVisualColumnsOnly(inner) : null;
    const visualFtsIds = new Set();
    if (wrapped) {
      const rows = searchModel.recallMediaIdsByFts({
        userId,
        ftsQuery: wrapped,
        whereConditions,
        whereParams,
      });
      for (const r of rows) {
        const id = Number(r.media_id);
        if (Number.isFinite(id)) visualFtsIds.add(id);
      }
      mergeFtsScores(segCands, rows, containsChinese(residual));
      ftsRows += rows.length;
    }
    const lexicalSpec = buildVisualEmbeddingGateLexicalSpec(residual);
    const lexicalTokens = lexicalSpec.tokens;
    const actionGroups = extractActionGroups(lexicalSpec.groups);
    const requiredGroupHits = calcRequiredGroupHits(lexicalSpec.groups.length);
    const embeddingQueryText = buildEmbeddingQueryFromCoreTokens(ftsCoreTokens);
    const embeddingRowsRaw = embeddingQueryText
      ? await recallMediaIdsByVisualEmbedding({
          userId,
          queryText: embeddingQueryText,
          whereConditions,
          whereParams,
        })
      : [];
    const embeddingRows = embeddingRowsRaw.filter((row) => {
      const id = Number(row.media_id);
      if (!Number.isFinite(id)) return false;
      if (visualFtsIds.has(id)) return true;
      return passLexicalGate(row.description_text, lexicalTokens, {
        minHits: 1,
        synonymGroups: lexicalSpec.groups,
        requiredGroupHits,
        actionGroups,
      });
    });
    if (embeddingRows.length > 0) {
      mergeVisualSemanticScores(
        segCands,
        embeddingRows.map((r) => ({ media_id: r.media_id, similarity: r.similarity })),
      );
      semanticRows += embeddingRows.length;
    }
  }

  return { termRows, ftsRows, semanticRows };
}

async function searchMediaResults({
  userId,
  query,
  whereConditions = [],
  whereParams = [],
  baseFilters,
  filterOptions,
  scopeConditions = [],
  scopeParams = [],
  pageNo = 1,
  pageSize = 20,
}) {
  const offset = Math.max(0, (pageNo - 1) * pageSize);
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  const hasQuery = normalizedQuery !== "" && normalizedQuery !== "*";

  if (!hasQuery) {
    const [list, total] = await Promise.all([
      searchModel.listMediaSearchResults({
        userId,
        ftsQuery: null,
        whereConditions,
        whereParams,
        limit: pageSize,
        offset,
      }),
      searchModel.countMediaSearchResults({
        userId,
        ftsQuery: null,
        whereConditions,
        whereParams,
      }),
    ]);
    return {
      list,
      total,
      stats: { termCount: 0, ftsCount: list.length, ocrCount: 0, semanticCount: 0 },
    };
  }

  if (baseFilters == null || filterOptions == null) {
    throw new Error("searchMediaResults: keyword search requires baseFilters and filterOptions");
  }

  // 整句一次召回：空格仅作句内多线索，不再拆成多段循环
  const segment = normalizedQuery;

  const rankCacheKey = makeSearchRankCacheKey({
    userId,
    normalizedQuery,
    whereConditions: [],
    whereParams: [],
    baseFilters,
    filterOptions,
    scopeConditions,
    scopeParams,
  });

  if (rankCacheKey) {
    const cached = getSearchRankCache(rankCacheKey);
    if (cached?.rankedIds?.length) {
      return {
        list: buildOrderedPageMedias(userId, cached.rankedIds, offset, pageSize),
        total: cached.rankedIds.length,
        stats: cached.stats,
      };
    }
  }

  const globalCandidates = new Map();

  const parsedIntent = parseQueryIntent(segment);
  const mergedFilters = mergeFilters(baseFilters, parsedIntent);
  const built = buildSearchQueryParts(mergedFilters, filterOptions);
  const { whereConditions: wc, whereParams: wp } = mergeScopeWhere(scopeConditions, scopeParams, built);

  const residual = (parsedIntent.residualQuery || "").trim();
  const hasStructured = Boolean(
    parsedIntent.filters?.timeDimension || parsedIntent.filters?.customDateRange || parsedIntent.filters?.location?.length,
  );

  // 先 segment 按空白拆段各自 ocr_text LIKE（并集去重），再以 residual 做视觉 FTS + 向量；≤2 单位另加 term+同义词。
  const ocrStats = applyOcrRecallForSegment(
    {
      segment,
      userId,
      whereConditions: wc,
      whereParams: wp,
    },
    globalCandidates,
  );
  const totalOcrRows = ocrStats.likeRows;

  const visualStats = await applyVisualRecallForSegment(
    {
      segment,
      residual,
      hasStructured,
      userId,
      whereConditions: wc,
      whereParams: wp,
    },
    globalCandidates,
  );
  const totalTermRows = visualStats.termRows;
  const totalFtsRows = visualStats.ftsRows;
  const totalSemanticRows = visualStats.semanticRows;

  const mergedIds = Array.from(globalCandidates.keys());
  if (mergedIds.length === 0) {
    return {
      list: [],
      total: 0,
      stats: {
        termCount: totalTermRows,
        ftsCount: totalFtsRows,
        ocrCount: totalOcrRows,
        semanticCount: totalSemanticRows,
      },
    };
  }

  const mediaRows = fetchMediasByIdsChunked(userId, mergedIds);
  const mediaMap = new Map(mediaRows.map((item) => [item.mediaId, item]));
  const ranked = sortCandidates(globalCandidates, mediaMap).filter((item) => mediaMap.has(item.mediaId));
  const pagedIds = ranked.slice(offset, offset + pageSize).map((item) => item.mediaId);
  const list = pagedIds.map((mediaId) => mediaMap.get(mediaId)).filter(Boolean);
  const total = ranked.length;
  const stats = {
    termCount: totalTermRows,
    ftsCount: totalFtsRows,
    ocrCount: totalOcrRows,
    semanticCount: totalSemanticRows,
  };

  if (rankCacheKey && ranked.length > 0) {
    setSearchRankCache(rankCacheKey, {
      rankedIds: ranked.map((item) => item.mediaId),
      stats,
    });
  }

  return {
    list,
    total,
    stats,
  };
}

/**
 * 分页获取筛选选项列表
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.type - 选项类型: 'city' | 'year' | 'month' | 'weekday'
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量（默认20）
 * @param {string} params.timeDimension - 时间维度（可选）
 * @param {string[]} [params.scopeConditions] - 范围条件（与统一列表 scope 一致，用于当前维度下选项）
 * @param {any[]} [params.scopeParams] - 范围条件参数
 * @returns {Object} { list: [], total: number }
 */
async function getFilterOptionsPaginated(params) {
  return searchModel.getFilterOptionsPaginated(params);
}

/**
 * 根据图片 ID 列表获取图片信息
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {Array<number>} params.imageIds - 图片ID列表
 * @returns {Array} 图片信息列表
 */
async function getMediasByIds(params) {
  return searchModel.getMediasByIds(params);
}

module.exports = {
  searchMediaResults,
  getFilterOptionsPaginated,
  getMediasByIds,
};
