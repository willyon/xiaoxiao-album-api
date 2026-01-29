/*
 * @Author: zhangshouchang
 * @Date: 2025-01-28
 * @Description: 查询意图解析器（规则型）
 * 从自然语言查询中提取结构化信息，自动填充筛选条件
 */

/**
 * 解析查询意图，提取时间、人物、场景、情感等结构化信息
 * @param {string} query - 用户输入的查询文本
 * @returns {Object} 解析后的筛选条件对象，格式与 filters 一致
 */
function parseQueryIntent(query) {
  if (!query || !query.trim()) {
    return {};
  }

  const normalizedQuery = query.trim();
  const filters = {};

  // ========== 时间提取 ==========
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1; // 1-12

  // 年份关键词
  if (normalizedQuery.includes("去年") || normalizedQuery.includes("前年")) {
    const year = normalizedQuery.includes("去年") ? currentYear - 1 : currentYear - 2;
    filters.timeDimension = "year";
    filters.selectedTimeValues = [year.toString()];
  } else if (normalizedQuery.includes("今年")) {
    filters.timeDimension = "year";
    filters.selectedTimeValues = [currentYear.toString()];
  } else if (normalizedQuery.includes("前年")) {
    filters.timeDimension = "year";
    filters.selectedTimeValues = [(currentYear - 2).toString()];
  }

  // 季节/月份关键词
  const seasonKeywords = {
    春天: ["03", "04", "05"],
    夏季: ["06", "07", "08"],
    夏天: ["06", "07", "08"],
    秋季: ["09", "10", "11"],
    秋天: ["09", "10", "11"],
    冬季: ["12", "01", "02"],
    冬天: ["12", "01", "02"],
  };

  for (const [keyword, months] of Object.entries(seasonKeywords)) {
    if (normalizedQuery.includes(keyword)) {
      filters.timeDimension = "month";
      filters.selectedTimeValues = months;
      break;
    }
  }

  // ========== 人物提取 ==========
  const personKeywords = {
    // 「宝宝」等词仅用于提示年龄段，不再强行限定人物数量，避免因 AI 分析缺失导致结果为空
    宝宝: { ageGroup: ["0-2", "3-5", "6-9"] },
    小孩: { ageGroup: ["0-2", "3-5", "6-9"] },
    儿童: { ageGroup: ["0-2", "3-5", "6-9"] },
    孩子: { ageGroup: ["0-2", "3-5", "6-9"] },
    成人: { ageGroup: ["20-29", "30-39", "40-49", "50-59", "60-69", "70+"] },
    大人: { ageGroup: ["20-29", "30-39", "40-49", "50-59", "60-69", "70+"] },
    老人: { ageGroup: ["60-69", "70+"] },
  };

  for (const [keyword, config] of Object.entries(personKeywords)) {
    if (normalizedQuery.includes(keyword)) {
      if (config.ageGroup) {
        filters.ageGroup = config.ageGroup;
      }
      if (config.personCount) {
        filters.personCount = config.personCount;
      }
      break;
    }
  }

  // ========== 场景提取 ==========
  const sceneKeywords = {
    海边: ["海滩", "海边", "海洋", "沙滩"],
    海滩: ["海滩", "海边", "海洋", "沙滩"],
    公园: ["公园", "绿地", "花园"],
    餐厅: ["餐厅", "美食", "食物"],
    家里: ["室内", "家"],
    室内: ["室内", "家"],
    户外: ["户外", "室外"],
    室外: ["户外", "室外"],
    山上: ["山", "山峰", "山顶"],
    山: ["山", "山峰", "山顶"],
  };

  for (const [keyword, tags] of Object.entries(sceneKeywords)) {
    if (normalizedQuery.includes(keyword)) {
      // 注意：scene_tags 不在 filters 中，需要通过 FTS 查询
      // 这里可以返回一个标记，让调用方知道需要添加场景筛选
      filters._sceneKeywords = tags;
      break;
    }
  }

  // ========== 情感提取 ==========
  const emotionKeywords = {
    开心: ["开心", "笑", "高兴", "快乐"],
    高兴: ["开心", "笑", "高兴", "快乐"],
    快乐: ["开心", "笑", "高兴", "快乐"],
    难过: ["难过", "哭", "悲伤", "伤心"],
    悲伤: ["难过", "哭", "悲伤", "伤心"],
    伤心: ["难过", "哭", "悲伤", "伤心"],
    生气: ["生气", "愤怒"],
    愤怒: ["生气", "愤怒"],
  };

  for (const [keyword, expressions] of Object.entries(emotionKeywords)) {
    if (normalizedQuery.includes(keyword)) {
      filters.expression = expressions;
      break;
    }
  }

  return filters;
}

/**
 * 将解析结果合并到现有 filters（不覆盖用户已设置的筛选）
 * @param {Object} existingFilters - 现有的筛选条件
 * @param {Object} parsedFilters - 解析出的筛选条件
 * @returns {Object} 合并后的筛选条件
 */
function mergeFilters(existingFilters, parsedFilters) {
  const merged = { ...existingFilters };

  // 只合并用户未设置的字段
  if (!merged.timeDimension && parsedFilters.timeDimension) {
    merged.timeDimension = parsedFilters.timeDimension;
    merged.selectedTimeValues = parsedFilters.selectedTimeValues;
  }

  // 注意：ageGroup 过滤可能过于严格，如果图片没有 age_tags 会被过滤掉
  // 暂时不自动设置 ageGroup，让用户手动选择或依赖向量搜索的语义匹配
  // if (!merged.ageGroup?.length && parsedFilters.ageGroup?.length) {
  //   merged.ageGroup = parsedFilters.ageGroup;
  // }

  if (!merged.personCount?.length && parsedFilters.personCount?.length) {
    merged.personCount = parsedFilters.personCount;
  }

  if (!merged.expression?.length && parsedFilters.expression?.length) {
    merged.expression = parsedFilters.expression;
  }

  // 场景关键词（通过 FTS 查询处理，这里只保留标记）
  if (parsedFilters._sceneKeywords) {
    merged._sceneKeywords = parsedFilters._sceneKeywords;
  }

  return merged;
}

module.exports = {
  parseQueryIntent,
  mergeFilters,
};
