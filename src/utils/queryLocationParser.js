/*
 * @Description: 查询地点解析工具
 */
const { LOCATION_DICTIONARY } = require('../config/searchSemanticDictionary')
const { uniqueTerms, collectMatches } = require('./querySemanticMatcher')

/**
 * 收集查询中的城市匹配信号。
 * @param {string} normalizedQuery - 归一化查询文本。
 * @returns {Array<object>} 城市信号分组。
 */
function collectCitySignals(normalizedQuery) {
  return collectMatches(normalizedQuery, LOCATION_DICTIONARY)
}

/**
 * 将城市信号转换为 location 过滤条件。
 * @param {Array<{label:string}>} cities - 城市信号列表。
 * @returns {{location:string[]}|null} 地点过滤条件。
 */
function buildLocationFilter(cities) {
  const values = uniqueTerms((cities || []).map((city) => city.label).filter(Boolean))
  return values.length > 0 ? { location: values } : null
}

module.exports = {
  collectCitySignals,
  buildLocationFilter
}
