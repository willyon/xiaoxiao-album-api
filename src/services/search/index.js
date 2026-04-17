/**
 * 搜索子模块聚合导出：统一收口各子域能力，便于 searchService 作为稳定门面引用。
 */
const { searchMediaResults } = require('./searchOrchestrator')
const { buildScopeConditions, buildFilterQueryParts } = require('./searchScopeAndFilters')
const { getFilterOptionsPaginated } = require('./searchFilterOptions')

module.exports = {
  searchMediaResults,
  buildScopeConditions,
  buildFilterQueryParts,
  getFilterOptionsPaginated
}
