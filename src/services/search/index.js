/**
 * 搜索子模块聚合导出：统一收口各子域能力，便于 searchService 作为稳定门面引用。
 */
const { searchMediaResults } = require('./searchOrchestrator')
const { buildScopeConditions, buildFilterQueryParts, mergeScopeWhere } = require('./searchScopeAndFilters')
const { fetchMediasByIdsChunked, buildOrderedPageMedias } = require('./searchMediaFetch')
const { getFilterOptionsPaginated } = require('./searchFilterOptions')
const {
  scoreChineseTermHits,
  mergeFtsScores,
  mergeVisualSemanticScores,
  scoreOcrTextLikeHits,
  sortCandidates,
  mergeCandidateMapsInto
} = require('./searchCandidateScoring')
const { applyOcrRecallForSegment } = require('./searchRecallOcr')
const { applyVisualRecallForSegment } = require('./searchRecallVisual')

module.exports = {
  searchMediaResults,
  buildScopeConditions,
  buildFilterQueryParts,
  mergeScopeWhere,
  fetchMediasByIdsChunked,
  buildOrderedPageMedias,
  scoreChineseTermHits,
  mergeFtsScores,
  mergeVisualSemanticScores,
  scoreOcrTextLikeHits,
  sortCandidates,
  mergeCandidateMapsInto,
  applyOcrRecallForSegment,
  applyVisualRecallForSegment,
  getFilterOptionsPaginated
}
