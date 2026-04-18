/*
 * @Description: 查询语义匹配通用工具
 */

/**
 * 归一化语义匹配文本（去空白并小写）。
 * @param {unknown} value - 原始输入值。
 * @returns {string} 归一化后的文本。
 */
function normalizeSemanticText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 去重并清理词项列表。
 * @param {string[]} [terms=[]] - 候选词项。
 * @returns {string[]} 去重后的词项。
 */
function uniqueTerms(terms = []) {
  const seen = new Set()
  const output = []
  for (const term of terms) {
    const value = typeof term === 'string' ? term.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    output.push(value)
  }
  return output
}

/**
 * 归一化查询文本。
 * @param {string} query - 查询文本。
 * @returns {string} 归一化结果。
 */
function normalizeQueryText(query) {
  return normalizeSemanticText(query)
}

/**
 * 从字典条目构建待匹配词组。
 * @param {{label:string,aliases?:string[]}} entry - 字典条目。
 * @returns {string[]} 词组列表。
 */
function buildGroupTerms(entry) {
  return uniqueTerms([entry.label, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeSemanticText))
}

/**
 * 将语义字典展开为可匹配候选项。
 * @param {Array<object>} dictionary - 语义字典。
 * @returns {Array<object>} 排序后的匹配候选。
 */
function buildAliasCandidates(dictionary) {
  const candidates = []
  for (const entry of dictionary) {
    const terms = buildGroupTerms(entry)
    for (const term of terms) {
      candidates.push({
        label: entry.label,
        term,
        terms,
        type: entry.type,
        filterValues: entry.filterValues,
        ...(entry.month != null ? { month: entry.month } : {})
      })
    }
  }
  return candidates.sort((a, b) => b.term.length - a.term.length || a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

/**
 * 判断区间是否与已有区间重叠。
 * @param {{start:number,end:number}} range - 待检查区间。
 * @param {Array<{start:number,end:number}>} occupiedRanges - 已占用区间。
 * @returns {boolean} 是否重叠。
 */
function isOverlapping(range, occupiedRanges) {
  return occupiedRanges.some((item) => !(range.end <= item.start || range.start >= item.end))
}

/**
 * 按起止位置排序区间。
 * @param {Array<{start:number,end:number}>} [ranges=[]] - 区间列表。
 * @returns {Array<{start:number,end:number}>} 排序后的区间。
 */
function sortRanges(ranges = []) {
  return [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * 在归一化查询中收集语义匹配结果。
 * @param {string} normalizedQuery - 归一化查询。
 * @param {Array<object>} dictionary - 语义字典。
 * @returns {Array<object>} 分组匹配结果（含 matchedRanges）。
 */
function collectMatches(normalizedQuery, dictionary) {
  if (!normalizedQuery) {
    return []
  }

  const occupiedRanges = []
  const groupedMatches = new Map()
  for (const candidate of buildAliasCandidates(dictionary)) {
    let searchFrom = 0
    while (searchFrom < normalizedQuery.length) {
      const start = normalizedQuery.indexOf(candidate.term, searchFrom)
      if (start < 0) break
      const range = { start, end: start + candidate.term.length }
      searchFrom = start + 1
      if (isOverlapping(range, occupiedRanges)) {
        continue
      }
      occupiedRanges.push(range)
      const existing = groupedMatches.get(candidate.label) || {
        label: candidate.label,
        terms: candidate.terms,
        matchedAliases: [],
        matchedRanges: [],
        type: candidate.type,
        filterValues: candidate.filterValues,
        ...(candidate.month != null ? { month: candidate.month } : {})
      }
      existing.matchedAliases.push(candidate.term)
      existing.matchedRanges.push(range)
      groupedMatches.set(candidate.label, existing)
    }
  }
  return Array.from(groupedMatches.values()).map((group) => ({
    ...group,
    matchedAliases: uniqueTerms(group.matchedAliases),
    matchedRanges: sortRanges(group.matchedRanges),
    primaryMatch: group.matchedAliases[0] || group.label
  }))
}

/**
 * 从查询中剔除匹配区间后得到 residual 文本。
 * @param {string} normalizedQuery - 归一化查询。
 * @param {Array<{start:number,end:number}>} ranges - 待剔除区间。
 * @returns {{residualQuery:string,residualSegments:string[]}} residual 结果。
 */
function collectResidualQuery(normalizedQuery, ranges) {
  if (!normalizedQuery) {
    return { residualQuery: '', residualSegments: [] }
  }

  const sortedRanges = sortRanges(ranges)
  let cursor = 0
  const residualSegments = []
  for (const range of sortedRanges) {
    if (cursor < range.start) {
      residualSegments.push(normalizedQuery.slice(cursor, range.start))
    }
    cursor = Math.max(cursor, range.end)
  }
  if (cursor < normalizedQuery.length) {
    residualSegments.push(normalizedQuery.slice(cursor))
  }

  return {
    residualQuery: residualSegments.join(''),
    residualSegments: residualSegments.filter(Boolean)
  }
}

module.exports = {
  uniqueTerms,
  normalizeQueryText,
  isOverlapping,
  collectMatches,
  collectResidualQuery
}
