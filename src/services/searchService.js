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
const { buildChineseQueryTerms, containsChinese, normalizeQueryForFts } = require("../utils/searchTermUtils");
const { generateTextEmbeddingForQuery } = require("./embeddingProvider");
const { segmentFieldForSearchTerms } = require("../utils/chineseSegmenter");
const { buildFinalLexicalTokensForResidual, passLexicalGate, getCoreTokensOnlyForResidual } = require("../utils/embeddingLexicalGate");
const { expandTermsWithSynonyms } = require("../utils/searchSynonymExpansion");

const _minSimParsed = parseFloat(process.env.VISUAL_EMBEDDING_MIN_SIMILARITY);
/** 与 query 向量点积（已归一化即余弦），低于则不进候选；默认 0.82，`.env` 的 VISUAL_EMBEDDING_MIN_SIMILARITY 覆盖 */
const VISUAL_EMBEDDING_MIN_SIMILARITY = Math.min(1, Math.max(0, Number.isFinite(_minSimParsed) ? _minSimParsed : 0.82));

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

function buildFtsQueryForToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const preprocessed = containsChinese(raw) ? normalizeQueryForFts(raw) : raw;
  const tokens = preprocessed.split(/\s+/).map(sanitizeFtsToken).filter(Boolean);
  return tokens.length > 0 ? tokens.join(" ") : null;
}

/** 长句视觉 FTS：已分好内容词时直接 sanitize 拼接，避免对整句再 jieba 一遍 */
function buildVisualFtsInnerFromCoreTokens(coreTokens) {
  const parts = (coreTokens || []).map((t) => sanitizeFtsToken(t)).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** 图片理解 FTS：caption_search_terms 为 description/标签/转写等 jieba，不含 OCR；OCR 见 ocr_search_terms 列。 */
const VISUAL_FTS5_COLUMN_GROUP =
  "{description_text keywords_text subject_tags_text action_tags_text scene_tags_text transcript_text caption_search_terms}";

function wrapFtsQueryForVisualColumnsOnly(innerQuery) {
  const inner = String(innerQuery || "").trim();
  if (!inner) return null;
  return `${VISUAL_FTS5_COLUMN_GROUP} : (${inner})`;
}

/** 仅 media_search_fts.ocr_search_terms 列（OCR 的 jieba 空格串，与 buildFtsQueryForToken 对齐） */
function wrapFtsQueryForOcrColumnOnly(innerQuery) {
  const inner = String(innerQuery || "").trim();
  if (!inner) return null;
  return `{ocr_search_terms} : (${inner})`;
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
      /** 图片理解侧召回或结构化标签命中（非 OCR term/FTS） */
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

/** media_search_terms 精确命中（短中文 1～2 字为主）；图片理解路径应排除 field_type=ocr（见 recall 参数）。 */
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
    if (row.field_type === "ocr") {
      candidate.hasOcrMatch = true;
    } else {
      candidate.hasVisualMatch = true;
    }
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

function scoreOcrSubstringHits(candidates, ocrRows) {
  for (const row of ocrRows || []) {
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.hasOcrMatch = true;
    candidate.score += SEARCH_TERM_FIELD_WEIGHTS.ocr;
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

/** 中文按字计、英文按词计，用于 ≥3 / ≤2 分支 */
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

/**
 * 视觉列 FTS 用 token：优先内容词；无核心词且 residual 很短时退回整段，避免短查询无法 MATCH。
 */
function getVisualFtsCoreTokensForResidual(residual) {
  const core = getCoreTokensOnlyForResidual(residual);
  if (core.length > 0) return core;
  const trimmed = String(residual || "").trim();
  if (!trimmed) return [];
  if (segmentLengthUnits(trimmed) <= 2) {
    return [trimmed];
  }
  return [];
}

/**
 * 向量字面护栏用词：与 buildFinalLexicalTokensForResidual 一致；为空时用短句种子+同义词（与 term 路径对齐），否则 1～2 单位查询 embedding 全被挡掉。
 */
function resolveLexicalTokensForEmbeddingGate(residual) {
  const fromCore = buildFinalLexicalTokensForResidual(residual);
  if (fromCore.length > 0) return fromCore;
  const trimmed = String(residual || "").trim();
  if (!trimmed) return [];
  const seeds = new Set();
  seeds.add(trimmed);
  if (!containsChinese(trimmed)) {
    for (const t of segmentFieldForSearchTerms(trimmed)) {
      if (t) seeds.add(t);
    }
  }
  return expandTermsWithSynonyms([...seeds]);
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
 * OCR：任意长度都走 ocr_search_terms FTS；长度 <3 额外查 media_search_terms（field_type=ocr）精确命中。
 */
function applyOcrRecallForSegment({ segment, userId, whereConditions, whereParams }, segCands) {
  const ocrLenUnits = segmentLengthUnits(segment);
  let termRows = 0;

  if (ocrLenUnits < 3) {
    const shortQueryTerms = buildChineseQueryTerms(segment);
    if (shortQueryTerms.length > 0) {
      const termRowsData = searchModel.recallMediaIdsByChineseTerms({
        userId,
        terms: shortQueryTerms.map((item) => item.term),
        whereConditions,
        whereParams,
        fieldTypes: ["ocr"],
      });
      mergeCandidateMapsInto(segCands, scoreChineseTermHits(termRowsData, shortQueryTerms));
      termRows = termRowsData.length;
    }
  }

  const ocrInner = buildFtsQueryForToken(segment);
  const ocrWrapped = ocrInner ? wrapFtsQueryForOcrColumnOnly(ocrInner) : null;
  const ocrRows = ocrWrapped
    ? searchModel.recallMediaIdsByOcrFts({
        userId,
        ftsQuery: ocrWrapped,
        whereConditions,
        whereParams,
      })
    : [];
  scoreOcrSubstringHits(segCands, ocrRows);
  return { ftsRows: ocrRows.length, termRows };
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
      const seeds = new Set();
      const trimmed = residual.trim();
      if (trimmed) seeds.add(trimmed);
      // 中文短句（单位数≤2）：整段即检索意图，不再走 jieba；英文/数字仍分词以便多词如 "cat dog"
      if (trimmed && !containsChinese(trimmed)) {
        for (const t of segmentFieldForSearchTerms(trimmed)) {
          if (t) seeds.add(t);
        }
      }
      const expanded = expandTermsWithSynonyms([...seeds]);
      const queryTerms = [...new Set(expanded)]
        .map((term) => {
          const termLen = Array.from(term).length;
          const boost = termLen >= 2 ? CHINESE_QUERY_TERM_BOOST.multiChar : CHINESE_QUERY_TERM_BOOST.singleChar;
          return { term, termLen, boost };
        })
        .sort((a, b) => b.termLen - a.termLen || a.term.localeCompare(b.term, "zh-Hans-CN"));

      if (queryTerms.length > 0) {
        const termRowsData = searchModel.recallMediaIdsByChineseTermsForVisual({
          userId,
          terms: queryTerms.map((item) => item.term),
          whereConditions,
          whereParams,
        });
        mergeCandidateMapsInto(segCands, scoreChineseTermHits(termRowsData, queryTerms));
        termRows += termRowsData.length;
      }
    }

    const ftsCoreTokens = getVisualFtsCoreTokensForResidual(residual);
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
    const lexicalTokens = resolveLexicalTokensForEmbeddingGate(residual);
    const embeddingRowsRaw = await recallMediaIdsByVisualEmbedding({
      userId,
      queryText: residual,
      whereConditions,
      whereParams,
    });
    const embeddingRows = embeddingRowsRaw.filter((row) => {
      const id = Number(row.media_id);
      if (!Number.isFinite(id)) return false;
      if (visualFtsIds.has(id)) return true;
      return passLexicalGate(row.description_text, lexicalTokens);
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
  ftsQuery,
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
        ftsQuery,
        whereConditions,
        whereParams,
        limit: pageSize,
        offset,
      }),
      searchModel.countMediaSearchResults({
        userId,
        ftsQuery,
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
    ftsQuery: null,
    whereConditions: [],
    whereParams: [],
    baseFilters,
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
  const built = buildSearchQueryParts("*", mergedFilters, filterOptions);
  const { whereConditions: wc, whereParams: wp } = mergeScopeWhere(scopeConditions, scopeParams, built);

  const residual = (parsedIntent.residualQuery || "").trim();
  const hasStructured = Boolean(
    parsedIntent.filters?.timeDimension || parsedIntent.filters?.customDateRange || parsedIntent.filters?.location?.length,
  );

  // OCR 用整句 segment 计长度：<3 额外 term 表；任意长度均 OCR FTS。视觉用 residual；有 residual 则任意长度均视觉 FTS + 向量，≤2 单位另加 term+同义词。
  // 1) OCR 与 2) 图片理解分离：先 OCR，再视觉（视觉侧不查 OCR term / 不走 OCR FTS）
  const ocrStats = applyOcrRecallForSegment(
    {
      segment,
      userId,
      whereConditions: wc,
      whereParams: wp,
    },
    globalCandidates,
  );
  const totalOcrRows = ocrStats.ftsRows + ocrStats.termRows;

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
