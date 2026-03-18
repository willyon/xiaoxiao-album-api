/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索业务逻辑服务
 */
const searchModel = require("../models/searchModel");
const pythonSearchClient = require("./pythonSearchClient");
const logger = require("../utils/logger");
const { SEARCH_TERM_FIELD_WEIGHTS, buildChineseQueryTerms, containsChinese, extractChineseRuns } = require("../utils/searchTermUtils");

/**
 * 搜索图片（支持复杂筛选条件）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @param {number} params.limit - 返回结果数量
 * @param {number} params.offset - 偏移量
 * @returns {Array} 搜索结果
 */
async function searchMediasByText(params) {
  return searchModel.searchMediasByText(params);
}

/**
 * 获取搜索结果总数
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @returns {number} 总记录数
 */
async function getSearchResultsCount(params) {
  return searchModel.getSearchResultsCount(params);
}

function ensureCandidate(candidates, mediaId) {
  if (!candidates.has(mediaId)) {
    candidates.set(mediaId, {
      mediaId,
      score: 0,
      chineseHits: 0,
      chineseDoubleHits: 0,
      ftsRank: null,
      vectorRank: null,
      matchedFields: new Set(),
    });
  }
  return candidates.get(mediaId);
}

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
    if (queryTerm.termLen >= 2) {
      candidate.chineseDoubleHits += 1;
    }
    candidate.matchedFields.add(row.field_type);
  }

  return candidates;
}

function mergeFtsScores(candidates, ftsRows, hasChineseQuery) {
  const baseScore = hasChineseQuery ? 28 : 90;
  for (let index = 0; index < (ftsRows || []).length; index += 1) {
    const row = ftsRows[index];
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.score += Math.max(6, baseScore - index);
    candidate.ftsRank = index + 1;
  }
}

function mergeVectorScores(candidates, vectorRows, hasChineseQuery, options = {}) {
  const { onlyExisting = false } = options;
  const baseScore = hasChineseQuery ? 14 : 36;
  for (let index = 0; index < (vectorRows || []).length; index += 1) {
    const row = vectorRows[index];
    const mediaId = Number(row.media_id);
    if (!Number.isFinite(mediaId)) continue;
    if (onlyExisting && !candidates.has(mediaId)) continue;
    const candidate = ensureCandidate(candidates, mediaId);
    candidate.score += Math.max(4, baseScore - index);
    candidate.vectorRank = index + 1;
  }
}

function buildChinesePrecisionRules(query) {
  const runs = extractChineseRuns(query);
  const maxRunLength = runs.reduce((max, run) => Math.max(max, Array.from(run).length), 0);
  return {
    maxRunLength,
    requiresDoubleHit: maxRunLength >= 2,
  };
}

function filterCandidatesForChinesePrecision(candidates, rules) {
  if (!rules?.requiresDoubleHit) {
    return candidates;
  }

  const filtered = new Map();
  for (const [mediaId, candidate] of candidates.entries()) {
    if (candidate.chineseDoubleHits > 0) {
      filtered.set(mediaId, candidate);
    }
  }
  return filtered;
}

function sortCandidates(candidates, mediaMap) {
  return Array.from(candidates.values()).sort((a, b) => {
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

async function searchMediasHybrid({
  userId,
  query,
  ftsQuery,
  whereConditions = [],
  whereParams = [],
  pageNo = 1,
  pageSize = 20,
  allowVector = false,
}) {
  const offset = Math.max(0, (pageNo - 1) * pageSize);
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  const hasQuery = normalizedQuery !== "" && normalizedQuery !== "*";

  if (!hasQuery) {
    const [list, total] = await Promise.all([
      searchModel.searchMediasByText({
        userId,
        ftsQuery,
        whereConditions,
        whereParams,
        limit: pageSize,
        offset,
      }),
      searchModel.getSearchResultsCount({
        userId,
        ftsQuery,
        whereConditions,
        whereParams,
      }),
    ]);
    return {
      list,
      total,
      stats: { termCount: 0, ftsCount: list.length, vectorCount: 0 },
    };
  }

  const hasChineseQuery = containsChinese(normalizedQuery);
  const chineseQueryTerms = hasChineseQuery ? buildChineseQueryTerms(normalizedQuery) : [];
  const chinesePrecisionRules = hasChineseQuery ? buildChinesePrecisionRules(normalizedQuery) : null;
  const recallLimit = Math.max(pageSize * 6, 120);

  const recalls = [
    Promise.resolve(
      hasChineseQuery
        ? searchModel.searchMediaIdsByChineseTerms({
            userId,
            terms: chineseQueryTerms.map((item) => item.term),
            whereConditions,
            whereParams,
            limit: recallLimit,
          })
        : [],
    ),
    Promise.resolve(
      searchModel.searchMediaIdsByFts({
        userId,
        ftsQuery,
        whereConditions,
        whereParams,
        limit: recallLimit,
      }),
    ),
    Promise.resolve(
      hasChineseQuery
        ? searchModel.countMediaIdsByChineseTerms({
            userId,
            terms: chineseQueryTerms.map((item) => item.term),
            whereConditions,
            whereParams,
          })
        : 0,
    ),
    Promise.resolve(
      searchModel.getSearchResultsCount({
        userId,
        ftsQuery,
        whereConditions,
        whereParams,
      }),
    ),
  ];

  if (allowVector) {
    recalls.push(
      (async () => {
        try {
          const { vector: queryVector } = await pythonSearchClient.encodeText(normalizedQuery);
          return pythonSearchClient.annSearchByVector(userId, queryVector, recallLimit);
        } catch (error) {
          logger.warn({
            message: "向量搜索失败，降级为纯文本召回",
            details: { userId, query: normalizedQuery, error: error.message },
          });
          return [];
        }
      })(),
    );
  } else {
    recalls.push(Promise.resolve([]));
  }

  const [termRows, ftsRows, termTotalCount, ftsTotalCount, vectorRows] = await Promise.all(recalls);
  let candidates = scoreChineseTermHits(termRows, chineseQueryTerms);
  mergeFtsScores(candidates, ftsRows, hasChineseQuery);
  const hasTextHits = candidates.size > 0;
  mergeVectorScores(candidates, vectorRows, hasChineseQuery, { onlyExisting: hasTextHits });
  candidates = filterCandidatesForChinesePrecision(candidates, chinesePrecisionRules);

  const mergedIds = Array.from(candidates.keys());
  if (mergedIds.length === 0) {
    return {
      list: [],
      total: 0,
      stats: { termCount: termRows.length, ftsCount: ftsRows.length, vectorCount: vectorRows.length },
    };
  }

  const mediaRows = await searchModel.getMediasByIds({ userId, imageIds: mergedIds });
  const mediaMap = new Map(mediaRows.map((item) => [item.mediaId, item]));
  const ranked = sortCandidates(candidates, mediaMap).filter((item) => mediaMap.has(item.mediaId));
  const pagedIds = ranked.slice(offset, offset + pageSize).map((item) => item.mediaId);
  const list = pagedIds.map((mediaId) => mediaMap.get(mediaId)).filter(Boolean);
  const total = ranked.length;

  return {
    list,
    total,
    stats: {
      termCount: termRows.length,
      ftsCount: ftsRows.length,
      vectorCount: vectorRows.length,
    },
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
  searchMediasByText,
  getSearchResultsCount,
  searchMediasHybrid,
  getFilterOptionsPaginated,
  getMediasByIds,
};
