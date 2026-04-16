/**
 * 搜索编排层：负责串联意图解析、筛选合并、OCR/视觉召回、候选排序、分页与缓存。
 * 本文件不承载底层算法细节，具体能力由各子模块提供。
 */
const searchModel = require('../../models/mediaModel')
const { makeSearchRankCacheKey, getSearchRankCache, setSearchRankCache } = require('../../utils/searchRankCacheStore')
const { parseQueryIntent, mergeFilters } = require('../../utils/queryIntentParser')
const { sortCandidates } = require('./searchCandidateScoring')
const { applyOcrRecallForSegment } = require('./searchRecallOcr')
const { applyVisualRecallForSegment } = require('./searchRecallVisual')
const { fetchMediasByIdsChunked, buildOrderedPageMedias } = require('./searchMediaFetch')
const { buildFilterQueryParts, mergeScopeWhere } = require('./searchScopeAndFilters')

/**
 * 执行搜索主流程，返回分页结果与召回统计。
 * @param {Object} params
 * @param {number} params.userId 用户 ID
 * @param {string} [params.query] 搜索关键词；空字符串或 `*` 视为仅筛选列表
 * @param {string[]} [params.whereConditions=[]] 预构建 WHERE 条件（无关键词场景）
 * @param {any[]} [params.whereParams=[]] 预构建 WHERE 参数（无关键词场景）
 * @param {Object} [params.baseFilters] 原始筛选条件（关键词搜索时必传）
 * @param {Object} [params.filterOptions] 筛选构造参数（关键词搜索时必传）
 * @param {string[]} [params.scopeConditions=[]] scope 条件
 * @param {any[]} [params.scopeParams=[]] scope 参数
 * @param {number} [params.pageNo=1] 页码（从 1 开始）
 * @param {number} [params.pageSize=20] 每页数量
 * @returns {Promise<{list: any[], total: number, stats: {termCount:number, ftsCount:number, ocrCount:number, semanticCount:number}}>}
 */
async function searchMediaResults({
  userId,
  query,
  whereConditions = [],
  whereParams = [],
  baseFilters,
  filterOptions,
  scopeConditions = [],
  scopeParams = [],
  pageNo = 1,
  pageSize = 20
}) {
  const offset = Math.max(0, (pageNo - 1) * pageSize)
  const normalizedQuery = typeof query === 'string' ? query.trim() : ''
  const hasQuery = normalizedQuery !== '' && normalizedQuery !== '*'

  if (!hasQuery) {
    const [list, total] = await Promise.all([
      searchModel.listMediaSearchResults({
        userId,
        ftsQuery: null,
        whereConditions,
        whereParams,
        limit: pageSize,
        offset
      }),
      searchModel.countMediaSearchResults({
        userId,
        ftsQuery: null,
        whereConditions,
        whereParams
      })
    ])
    return {
      list,
      total,
      stats: { termCount: 0, ftsCount: list.length, ocrCount: 0, semanticCount: 0 }
    }
  }

  if (baseFilters == null || filterOptions == null) {
    throw new Error('searchMediaResults: keyword search requires baseFilters and filterOptions')
  }

  // 整句一次召回：空格仅作句内多线索，不再拆成多段循环
  const segment = normalizedQuery

  const rankCacheKey = makeSearchRankCacheKey({
    userId,
    normalizedQuery,
    whereConditions: [],
    whereParams: [],
    baseFilters,
    filterOptions,
    scopeConditions,
    scopeParams
  })

  if (rankCacheKey) {
    const cached = getSearchRankCache(rankCacheKey)
    if (cached?.rankedIds?.length) {
      return {
        list: buildOrderedPageMedias(userId, cached.rankedIds, offset, pageSize),
        total: cached.rankedIds.length,
        stats: cached.stats
      }
    }
  }

  const globalCandidates = new Map()

  const parsedIntent = parseQueryIntent(segment)
  const mergedFilters = mergeFilters(baseFilters, parsedIntent)
  const built = buildFilterQueryParts(mergedFilters, filterOptions)
  const { whereConditions: wc, whereParams: wp } = mergeScopeWhere(scopeConditions, scopeParams, built)

  const residual = (parsedIntent.residualQuery || '').trim()
  const hasStructured = Boolean(
    parsedIntent.filters?.timeDimension || parsedIntent.filters?.customDateRange || parsedIntent.filters?.location?.length
  )

  // 先 segment 按空白拆段各自 ocr_text LIKE（并集去重），再以 residual 做视觉 FTS + 向量；≤2 单位另加 term+同义词。
  const ocrStats = applyOcrRecallForSegment(
    {
      segment,
      userId,
      whereConditions: wc,
      whereParams: wp
    },
    globalCandidates
  )
  const totalOcrRows = ocrStats.likeRows

  const visualStats = await applyVisualRecallForSegment(
    {
      segment,
      residual,
      hasStructured,
      userId,
      whereConditions: wc,
      whereParams: wp
    },
    globalCandidates
  )
  const totalTermRows = visualStats.termRows
  const totalFtsRows = visualStats.ftsRows
  const totalSemanticRows = visualStats.semanticRows

  const mergedIds = Array.from(globalCandidates.keys())
  if (mergedIds.length === 0) {
    return {
      list: [],
      total: 0,
      stats: {
        termCount: totalTermRows,
        ftsCount: totalFtsRows,
        ocrCount: totalOcrRows,
        semanticCount: totalSemanticRows
      }
    }
  }

  const mediaRows = fetchMediasByIdsChunked(userId, mergedIds)
  const mediaMap = new Map(mediaRows.map((item) => [item.mediaId, item]))
  const ranked = sortCandidates(globalCandidates, mediaMap).filter((item) => mediaMap.has(item.mediaId))
  const pagedIds = ranked.slice(offset, offset + pageSize).map((item) => item.mediaId)
  const list = pagedIds.map((mediaId) => mediaMap.get(mediaId)).filter(Boolean)
  const total = ranked.length
  const stats = {
    termCount: totalTermRows,
    ftsCount: totalFtsRows,
    ocrCount: totalOcrRows,
    semanticCount: totalSemanticRows
  }

  if (rankCacheKey && ranked.length > 0) {
    setSearchRankCache(rankCacheKey, {
      rankedIds: ranked.map((item) => item.mediaId),
      stats
    })
  }

  return {
    list,
    total,
    stats
  }
}

module.exports = {
  searchMediaResults
}
