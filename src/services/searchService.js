/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索业务逻辑服务
 */
const searchModel = require("../models/searchModel");

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
async function searchImagesByText(params) {
  return searchModel.searchImagesByText(params);
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

/**
 * 获取搜索建议（基于现有标签）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.prefix - 搜索前缀
 * @param {number} params.limit - 返回数量限制
 * @returns {Array<string>} 搜索建议列表
 */
async function getSearchSuggestions(params) {
  return searchModel.getSearchSuggestions(params);
}

/**
 * 分页获取筛选选项列表
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.type - 选项类型: 'city' | 'year' | 'month' | 'weekday'
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量（默认20）
 * @param {string} params.timeDimension - 时间维度（可选）
 * @returns {Object} { data: [], total: 0, hasMore: false }
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
async function getImagesByIds(params) {
  return searchModel.getImagesByIds(params);
}

module.exports = {
  searchImagesByText,
  getSearchResultsCount,
  getSearchSuggestions,
  getFilterOptionsPaginated,
  getImagesByIds,
};
