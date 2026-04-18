/*
 * @Author: zhangshouchang
 * @Date: 2025-01-28
 * @Description: 查询意图解析器
 * 从自然语言查询中提取必须走字段过滤的结构化信息（时间、地点）；residual 仅去掉上述片段。
 */
const { parseQuerySemanticSignals } = require('./querySemanticParser')

/**
 * 解析查询意图，提取时间、地点等结构化信息
 * @param {string} query - 用户输入的查询文本。
 * @returns {{ filters: Record<string, unknown>, residualQuery: string }} 结构化筛选与剩余查询文本。
 */
function parseQueryIntent(query) {
  if (!query || !query.trim()) {
    return {
      filters: {},
      residualQuery: ''
    }
  }

  const normalizedQuery = query.trim()
  const parsed = parseQuerySemanticSignals(normalizedQuery)
  const filters = {
    ...(parsed?.primaryTimeFilter || {}),
    ...(parsed?.primaryLocationFilter || {})
  }

  return {
    filters,
    residualQuery: parsed?.residualQuery || ''
  }
}

/**
 * 将解析结果合并到现有 filters（不覆盖用户已设置的筛选）
 * @param {Record<string, unknown>} existingFilters - 现有筛选条件。
 * @param {Record<string, unknown>} parsedFilters - 解析出的筛选条件。
 * @returns {Record<string, unknown>} 合并后的筛选条件。
 */
function mergeFilters(existingFilters, parsedFilters) {
  const merged = { ...existingFilters }
  const normalizedParsed = parsedFilters?.filters || parsedFilters || {}

  // 只合并用户未设置的字段。侧栏默认「全部」为 timeDimension === 'all'，视为未指定时间轴，仍允许合并搜索框内自然语言时间。
  const timeDimensionUnset = !merged.timeDimension || merged.timeDimension === 'all'
  if (timeDimensionUnset && normalizedParsed.timeDimension) {
    merged.timeDimension = normalizedParsed.timeDimension
    merged.selectedTimeValues = normalizedParsed.selectedTimeValues
  }
  if (!merged.customDateRange && normalizedParsed.customDateRange) {
    merged.customDateRange = normalizedParsed.customDateRange
  }
  if (!merged.location?.length && normalizedParsed.location?.length) {
    merged.location = normalizedParsed.location
  }

  return merged
}

module.exports = {
  parseQueryIntent,
  mergeFilters
}
