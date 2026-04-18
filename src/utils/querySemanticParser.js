/*
 * @Description: 中文场景搜索查询解析器
 * 从自然语言中提取时间、城市信号，供结构化筛选；residualQuery 仅去掉上述片段。
 */
const { normalizeQueryText, collectResidualQuery } = require('./querySemanticMatcher')
const { collectCitySignals, buildLocationFilter } = require('./queryLocationParser')
const { collectTimeSignals, pickPrimaryTimeFilter } = require('./queryTimeParser')

/**
 * 解析查询语义信号，提取时间和地点筛选信息。
 * @param {string} query - 用户输入的查询文本。
 * @returns {{
 * normalizedQuery: string,
 * cities: Array<object>,
 * timeSignals: Array<object>,
 * allSignals: Array<object>,
 * summary: { cityLabels: string[], timeLabels: string[] },
 * primaryTimeFilter: object|null,
 * primaryLocationFilter: object|null,
 * residualQuery: string,
 * residualSegments: string[]
 * }} 语义解析结果。
 */
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
  parseQuerySemanticSignals
}
