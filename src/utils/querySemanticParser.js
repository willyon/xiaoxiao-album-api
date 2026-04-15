/*
 * @Description: 中文场景搜索查询解析器
 * 从自然语言中提取时间、城市信号，供结构化筛选；residualQuery 仅去掉上述片段。
 */
const { normalizeQueryText, collectResidualQuery } = require('./querySemanticMatcher')
const { collectCitySignals, buildLocationFilter } = require('./queryLocationParser')
const { collectTimeSignals, pickPrimaryTimeFilter } = require('./queryTimeParser')

function parseQuerySemanticSignals(query) {
  const normalizedQuery = normalizeQueryText(query)
  const cities = collectCitySignals(normalizedQuery)
  const timeSignals = collectTimeSignals(normalizedQuery)
  const allSignals = [...cities.map((group) => ({ category: 'city', ...group })), ...timeSignals.map((group) => ({ category: 'time', ...group }))]
  const rangesStrippedForStructuredFilters = [
    ...cities.flatMap((group) => group.matchedRanges || []),
    ...timeSignals.flatMap((group) => group.matchedRanges || [])
  ]
  const { residualQuery, residualSegments } = collectResidualQuery(normalizedQuery, rangesStrippedForStructuredFilters)

  return {
    normalizedQuery,
    cities,
    timeSignals,
    allSignals,
    summary: {
      cityLabels: cities.map((group) => group.label),
      timeLabels: timeSignals.map((group) => group.label)
    },
    primaryTimeFilter: pickPrimaryTimeFilter(timeSignals),
    primaryLocationFilter: buildLocationFilter(cities),
    residualQuery,
    residualSegments
  }
}

module.exports = {
  parseQuerySemanticSignals,
  normalizeQueryText
}
