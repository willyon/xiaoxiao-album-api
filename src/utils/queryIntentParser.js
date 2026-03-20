/*
 * @Author: zhangshouchang
 * @Date: 2025-01-28
 * @Description: 查询意图解析器
 * 从自然语言查询中提取必须走字段过滤的结构化信息（时间、地点）；residual 仅去掉上述片段，主体/动作/场景仍保留给 FTS。
 */
const { parseQuerySemanticSignals } = require("./querySemanticParser");

/**
 * 解析查询意图，提取时间、地点等结构化信息
 * @param {string} query - 用户输入的查询文本
 * @returns {Object} 解析后的筛选条件对象，格式与 filters 一致
 */
function parseQueryIntent(query) {
  if (!query || !query.trim()) {
    return {
      filters: {},
      residualQuery: "",
      semantic: null,
      hasStructuredSignals: false,
    };
  }

  const normalizedQuery = query.trim();
  const semantic = parseQuerySemanticSignals(normalizedQuery);
  const filters = {
    ...(semantic?.primaryTimeFilter || {}),
    ...(semantic?.primaryLocationFilter || {}),
  };

  return {
    filters,
    residualQuery: semantic?.residualQuery || "",
    semantic,
    hasStructuredSignals: Boolean(semantic?.hasStructuredSignals),
  };
}

/**
 * 将解析结果合并到现有 filters（不覆盖用户已设置的筛选）
 * @param {Object} existingFilters - 现有的筛选条件
 * @param {Object} parsedFilters - 解析出的筛选条件
 * @returns {Object} 合并后的筛选条件
 */
function mergeFilters(existingFilters, parsedFilters) {
  const merged = { ...existingFilters };
  const normalizedParsed = parsedFilters?.filters || parsedFilters || {};

  // 只合并用户未设置的字段
  if (!merged.timeDimension && normalizedParsed.timeDimension) {
    merged.timeDimension = normalizedParsed.timeDimension;
    merged.selectedTimeValues = normalizedParsed.selectedTimeValues;
  }
  if (!merged.customDateRange && normalizedParsed.customDateRange) {
    merged.customDateRange = normalizedParsed.customDateRange;
  }
  if (!merged.location?.length && normalizedParsed.location?.length) {
    merged.location = normalizedParsed.location;
  }

  return merged;
}

module.exports = {
  parseQueryIntent,
  mergeFilters,
};
