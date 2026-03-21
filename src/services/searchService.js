/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索业务逻辑服务
 */
const searchModel = require("../models/searchModel");
const {
  makeSearchRankCacheKey,
  getSearchRankCache,
  setSearchRankCache,
} = require("../utils/searchRankCacheStore");
const {
  FTS_RANKING,
  SEARCH_TERM_FIELD_WEIGHTS,
  STRUCTURED_COMBO_BOOSTS,
  STRUCTURED_ROLE_BOOSTS,
} = require("../config/searchRankingWeights");
const { parseQueryIntent, mergeFilters } = require("../utils/queryIntentParser");
const { buildSearchQueryParts } = require("../utils/buildSearchQueryParts");
const { parseQuerySemanticSignals } = require("../utils/querySemanticParser");
const { normalizeSemanticText } = require("../utils/querySemanticMatcher");
const { buildChineseQueryTerms, containsChinese, normalizeQueryForFts } = require("../utils/searchTermUtils");

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

function fetchSearchDocsByMediaIdsChunked(userId, imageIds) {
  if (!imageIds.length) return [];
  const rows = [];
  for (let i = 0; i < imageIds.length; i += SQLITE_IN_CLAUSE_CHUNK) {
    rows.push(
      ...searchModel.getSearchDocsByMediaIds({
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

function scoreOcrSubstringHits(candidates, ocrRows) {
  for (const row of ocrRows || []) {
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.hasOcrMatch = true;
    candidate.score += SEARCH_TERM_FIELD_WEIGHTS.ocr;
  }
}

function normalizeFieldText(value) {
  return typeof value === "string" ? normalizeSemanticText(value) : "";
}

function fieldIncludesAny(text, terms = []) {
  if (!text || !Array.isArray(terms) || terms.length === 0) {
    return false;
  }
  return terms.some((term) => text.includes(term));
}

function boostStructuredMatches(candidates, searchDocs, structuredSignals) {
  if (!structuredSignals?.hasRoleSignals) {
    return;
  }

  const searchDocMap = new Map((searchDocs || []).map((doc) => [Number(doc.media_id), doc]));
  for (const candidate of candidates.values()) {
    const doc = searchDocMap.get(candidate.mediaId);
    const subjectText = normalizeFieldText(doc?.subject_tags_text);
    const actionText = normalizeFieldText(doc?.action_tags_text);
    const sceneText = normalizeFieldText(doc?.scene_tags_text);

    const hasSubjectSignal =
      candidate.matchedFields.has("subject_tags")
      || structuredSignals.subjects.some((group) => fieldIncludesAny(subjectText, group.terms));
    const hasActionSignal =
      candidate.matchedFields.has("action_tags")
      || structuredSignals.actions.some((group) => fieldIncludesAny(actionText, group.terms));
    const hasSceneSignal =
      candidate.matchedFields.has("scene_tags")
      || structuredSignals.scenes.some((group) => fieldIncludesAny(sceneText, group.terms));

    candidate.roleSignals.subject = hasSubjectSignal;
    candidate.roleSignals.action = hasActionSignal;
    candidate.roleSignals.scene = hasSceneSignal;

    if (hasSubjectSignal) candidate.score += STRUCTURED_ROLE_BOOSTS.subject;
    if (hasActionSignal) candidate.score += STRUCTURED_ROLE_BOOSTS.action;
    if (hasSceneSignal) candidate.score += STRUCTURED_ROLE_BOOSTS.scene;

    if (hasSubjectSignal && hasActionSignal && hasSceneSignal) {
      candidate.score += STRUCTURED_COMBO_BOOSTS.subjectActionScene;
    } else {
      if (hasSubjectSignal && hasActionSignal) candidate.score += STRUCTURED_COMBO_BOOSTS.subjectAction;
      if (hasSubjectSignal && hasSceneSignal) candidate.score += STRUCTURED_COMBO_BOOSTS.subjectScene;
      if (hasActionSignal && hasSceneSignal) candidate.score += STRUCTURED_COMBO_BOOSTS.actionScene;
    }

    if (hasSubjectSignal || hasActionSignal || hasSceneSignal) {
      candidate.hasVisualMatch = true;
    }
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
    const roleCountA = Number(a.roleSignals.subject) + Number(a.roleSignals.action) + Number(a.roleSignals.scene);
    const roleCountB = Number(b.roleSignals.subject) + Number(b.roleSignals.action) + Number(b.roleSignals.scene);
    if (roleCountB !== roleCountA) {
      return roleCountB - roleCountA;
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
 * 仅 OCR：长度 <3（segmentLengthUnits）只查 media_search_terms（field_type=ocr），否则查 ocr_search_terms FTS。
 */
function applyOcrRecallForSegment(
  { segment, userId, whereConditions, whereParams },
  segCands,
) {
  const ocrLenUnits = segmentLengthUnits(segment);

  if (ocrLenUnits < 3) {
    let termRows = 0;
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
    return { ftsRows: 0, termRows };
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
  return { ftsRows: ocrRows.length, termRows: 0 };
}

/**
 * 仅图片理解：筛选 / 视觉列 FTS / media_search_terms（不含 OCR 行）。
 */
function applyVisualRecallForSegment(
  {
    segment,
    residual,
    hasStructured,
    isLongBranch,
    userId,
    whereConditions,
    whereParams,
  },
  segCands,
) {
  let termRows = 0;
  let ftsRows = 0;

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
      if (isLongBranch) {
        const inner = buildFtsQueryForToken(residual);
        const wrapped = inner ? wrapFtsQueryForVisualColumnsOnly(inner) : null;
        if (wrapped) {
          const rows = searchModel.recallMediaIdsByFts({
            userId,
            ftsQuery: wrapped,
            whereConditions,
            whereParams,
          });
          mergeFtsScores(segCands, rows, containsChinese(residual));
          ftsRows += rows.length;
        }
      } else {
        const shortQueryTerms = buildChineseQueryTerms(residual);
        if (shortQueryTerms.length > 0) {
          const termRowsData = searchModel.recallMediaIdsByChineseTermsForVisual({
            userId,
            terms: shortQueryTerms.map((item) => item.term),
            whereConditions,
            whereParams,
          });
          mergeCandidateMapsInto(segCands, scoreChineseTermHits(termRowsData, shortQueryTerms));
          termRows += termRowsData.length;
        } else {
          const inner = buildFtsQueryForToken(residual);
          const wrapped = inner ? wrapFtsQueryForVisualColumnsOnly(inner) : null;
          if (wrapped) {
            const rows = searchModel.recallMediaIdsByFts({
              userId,
              ftsQuery: wrapped,
              whereConditions,
              whereParams,
            });
            mergeFtsScores(segCands, rows, false);
            ftsRows += rows.length;
          }
        }
      }
    }

  return { termRows, ftsRows };
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
      stats: { termCount: 0, ftsCount: list.length, ocrCount: 0 },
    };
  }

  if (baseFilters == null || filterOptions == null) {
    throw new Error("searchMediaResults: keyword search requires baseFilters and filterOptions");
  }

  const segments = normalizedQuery.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) {
    return {
      list: [],
      total: 0,
      stats: { termCount: 0, ftsCount: 0, ocrCount: 0 },
    };
  }

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
  let totalTermRows = 0;
  let totalFtsRows = 0;
  let totalOcrRows = 0;

  for (const segment of segments) {
    const parsedIntent = parseQueryIntent(segment);
    const mergedFilters = mergeFilters(baseFilters, parsedIntent);
    const built = buildSearchQueryParts("*", mergedFilters, filterOptions);
    const { whereConditions: wc, whereParams: wp } = mergeScopeWhere(scopeConditions, scopeParams, built);

    const residual = (parsedIntent.residualQuery || "").trim();
    const hasStructured = Boolean(
      parsedIntent.filters?.timeDimension
      || parsedIntent.filters?.customDateRange
      || parsedIntent.filters?.location?.length
    );

    // 长短分支与 OCR 是否走 FTS：均按「去掉时间/地点后的 residual」计长度；residual 为空时长度为 0
    const residualLenUnits = segmentLengthUnits(residual);
    const isLongBranch = residualLenUnits >= 3;

    let segCands = new Map();

    // 1) OCR 与 2) 图片理解分离：先 OCR，再视觉（视觉侧不查 OCR term / 不走 OCR FTS）
    const ocrStats = applyOcrRecallForSegment(
      {
        segment,
        userId,
        whereConditions: wc,
        whereParams: wp,
      },
      segCands,
    );
    totalOcrRows += ocrStats.ftsRows + ocrStats.termRows;

    const visualStats = applyVisualRecallForSegment(
      {
        segment,
        residual,
        hasStructured,
        isLongBranch,
        userId,
        whereConditions: wc,
        whereParams: wp,
      },
      segCands,
    );
    totalTermRows += visualStats.termRows;
    totalFtsRows += visualStats.ftsRows;

    if (segCands.size > 0) {
      const segmentStructuredSignals = parseQuerySemanticSignals(segment);
      const segIds = Array.from(segCands.keys());
      const segDocs = fetchSearchDocsByMediaIdsChunked(userId, segIds);
      boostStructuredMatches(segCands, segDocs, segmentStructuredSignals);
    }

    mergeCandidateMapsInto(globalCandidates, segCands);
  }

  const mergedIds = Array.from(globalCandidates.keys());
  if (mergedIds.length === 0) {
    return {
      list: [],
      total: 0,
      stats: {
        termCount: totalTermRows,
        ftsCount: totalFtsRows,
        ocrCount: totalOcrRows,
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
