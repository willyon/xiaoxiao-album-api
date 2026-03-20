/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索业务逻辑服务
 */
const searchModel = require("../models/searchModel");
const {
  FTS_RANKING,
  SEARCH_TERM_FIELD_WEIGHTS,
  STRUCTURED_COMBO_BOOSTS,
  STRUCTURED_ROLE_BOOSTS,
} = require("../config/searchRankingWeights");
const { parseQuerySemanticSignals } = require("../utils/querySemanticParser");
const { normalizeSemanticText } = require("../utils/querySemanticMatcher");
const {
  buildChineseQueryTerms,
  containsChinese,
  extractChineseRuns,
  normalizeQueryForFts,
} = require("../utils/searchTermUtils");

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

function ensureCandidate(candidates, mediaId) {
  if (!candidates.has(mediaId)) {
    candidates.set(mediaId, {
      mediaId,
      score: 0,
      chineseHits: 0,
      ftsRank: null,
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
  }
}

function sortCandidates(candidates, mediaMap) {
  return Array.from(candidates.values()).sort((a, b) => {
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

async function searchMediaResults({
  userId,
  query,
  ftsQuery,
  whereConditions = [],
  whereParams = [],
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
      stats: { termCount: 0, ftsCount: list.length },
    };
  }

  const hasChineseQuery = containsChinese(normalizedQuery);
  // 先按空格分词：每个 token 内再用连续中文段长度判断是否把它拆成 1~2 字去召回
  // - token 内最长连续中文段长度 <= 2：走 media_search_terms
  // - token 内最长连续中文段长度 >= 3：该 token 仅走 FTS（避免语义被拆开造成噪音）
  const tokens = hasChineseQuery
    ? normalizedQuery
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const shortChineseTokens = [];
  const longChineseTokens = [];
  for (const token of tokens) {
    const runs = extractChineseRuns(token);
    if (!runs || runs.length === 0) continue;
    const maxRunLen = runs.reduce((max, run) => Math.max(max, Array.from(run).length), 0);
    if (maxRunLen <= 2) {
      shortChineseTokens.push(token);
    } else {
      longChineseTokens.push(token);
    }
  }

  const shouldRecallChineseTerms = shortChineseTokens.length > 0;
  const shouldRecallFts = longChineseTokens.length > 0;
  const chineseQueryTermItems = shortChineseTokens.flatMap((token) => buildChineseQueryTerms(token));
  const chineseQueryTerms = Array.from(
    chineseQueryTermItems.reduce((acc, item) => {
      const current = acc.get(item.term);
      if (!current || item.termLen > current.termLen) {
        acc.set(item.term, item);
      }
      return acc;
    }, new Map()).values(),
  ).sort((a, b) => b.termLen - a.termLen || a.term.localeCompare(b.term, "zh-Hans-CN"));
  const structuredSignals = hasChineseQuery ? parseQuerySemanticSignals(normalizedQuery) : null;
  const recallLimit = Math.max(pageSize * 6, 120);

  const termRecalls = shouldRecallChineseTerms
    ? [
        searchModel.recallMediaIdsByChineseTerms({
          userId,
          terms: chineseQueryTerms.map((item) => item.term),
          whereConditions,
          whereParams,
          limit: recallLimit,
        }),
      ]
    : [];
  const ftsRecalls = shouldRecallFts
    ? longChineseTokens
        .map((token) => buildFtsQueryForToken(token))
        .filter(Boolean)
        .map((singleFtsQuery) => searchModel.recallMediaIdsByFts({
          userId,
          ftsQuery: singleFtsQuery,
          whereConditions,
          whereParams,
          limit: recallLimit,
        }))
    : [];
  const [termRecallGroups, ftsRecallGroups] = await Promise.all([
    Promise.all(termRecalls),
    Promise.all(ftsRecalls),
  ]);
  const termRows = termRecallGroups.flat();
  const ftsRows = ftsRecallGroups.flat();
  let candidates = scoreChineseTermHits(termRows, chineseQueryTerms);
  for (const ftsRowsOfToken of ftsRecallGroups) {
    mergeFtsScores(candidates, ftsRowsOfToken, hasChineseQuery);
  }

  const mergedIds = Array.from(candidates.keys());
  if (mergedIds.length === 0) {
    return {
      list: [],
      total: 0,
      stats: { termCount: termRows.length, ftsCount: ftsRows.length },
    };
  }

  const [mediaRows, searchDocs] = await Promise.all([
    searchModel.getMediasByIds({ userId, imageIds: mergedIds }),
    searchModel.getSearchDocsByMediaIds({ userId, imageIds: mergedIds }),
  ]);
  const mediaMap = new Map(mediaRows.map((item) => [item.mediaId, item]));
  boostStructuredMatches(candidates, searchDocs, structuredSignals);
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
  searchMediaResults,
  getFilterOptionsPaginated,
  getMediasByIds,
};
