/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能API控制器
 */

const { SUCCESS_CODES } = require('../constants/messageCodes')
const searchService = require('../services/search')
const { addFullUrlToMedia } = require('../services/mediaService')
const faceClusterService = require('../services/faceCluster')
const logger = require('../utils/logger')
const asyncHandler = require('../utils/asyncHandler')
const { parsePagination, parsePositiveIntParam, throwInvalidParametersError } = require('../utils/requestParams')

/**
 * 搜索/列表图片（统一接口）
 * POST /search/media
 * body: query?, filters?, pageNo, pageSize, clusterId?
 *       可选 scope：source?, type?, albumId?（传了 source 且不为 search 时在范围内列表/搜索；未传或 source=search 为全局搜索）
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleSearchMedias(req, res) {
  const { userId } = req.user
  const { query, filters = {}, clusterId: clusterIdRaw, source, type, albumId } = req.body
  const { pageNo, pageSize } = parsePagination(
    { pageNo: req.body.pageNo, pageSize: req.body.pageSize },
    { pageNo: 1, pageSize: 20 }
  )

  const validClusterId = clusterIdRaw != null && clusterIdRaw !== '' ? parsePositiveIntParam(clusterIdRaw) : null

  const validSources = ['search', 'favorites', 'timeline', 'album', 'location', 'people']
  const hasScope = source && source !== 'search' && validSources.includes(source)

  let searchQuery = query && query.trim() ? query.trim() : '*'
  const hasQuery = searchQuery !== '*' && searchQuery.trim() !== ''

  const filterOptions = { userId, clusterId: validClusterId }

  logger.info({
    message: hasScope ? `范围列表/搜索: ${userId}` : `用户搜索: ${userId}`,
    details: {
      query: searchQuery,
      filters,
      pageNo,
      pageSize,
      clusterId: validClusterId,
      source: hasScope ? source : null
    }
  })

  const scope = hasScope ? { source, type, albumId, clusterId: validClusterId } : null
  const searchResult = await runSearchMediaFlow({
    userId,
    query: searchQuery,
    hasQuery,
    filters,
    filterOptions,
    scope,
    pageNo,
    pageSize
  })

  let resultsWithUrls = await addFullUrlToMedia(searchResult.list)
  if (hasScope && source === 'people' && validClusterId != null && resultsWithUrls.length > 0) {
    const mediaIds = resultsWithUrls.map((item) => item.mediaId).filter((id) => id != null)
    const faceEmbeddingIdMap = faceClusterService.getFaceEmbeddingIdByMediaIdInCluster(userId, validClusterId, mediaIds)
    resultsWithUrls = resultsWithUrls.map((item) => ({
      ...item,
      faceEmbeddingId: faceEmbeddingIdMap.get(item.mediaId) ?? null
    }))
  }

  if (hasScope) {
    logger.info({
      message: `范围列表/搜索完成: ${userId}`,
      details: { source, resultCount: resultsWithUrls.length, total: searchResult.total }
    })
    return res.sendResponse({
      data: { list: resultsWithUrls, total: searchResult.total },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED
    })
  }

  logger.info({
    message: `搜索完成: ${userId}`,
    details: {
      query,
      resultCount: resultsWithUrls.length,
      totalCount: searchResult.total,
      termCount: searchResult.stats?.termCount || 0,
      ftsCount: searchResult.stats?.ftsCount || 0,
      appliedFilters: extractAppliedFilters(filters)
    }
  })

  res.sendResponse({
    data: {
      list: resultsWithUrls,
      total: searchResult.total
    },
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED
  })
}

async function runSearchMediaFlow({ userId, query, hasQuery, filters, filterOptions, scope, pageNo, pageSize }) {
  const builtScope = scope ? searchService.buildScopeConditions(scope, userId) : { scopeConditions: [], scopeParams: [] }
  const { scopeConditions, scopeParams } = builtScope

  if (hasQuery) {
    return searchService.searchMediaResults({
      userId,
      query,
      baseFilters: filters,
      filterOptions,
      scopeConditions,
      scopeParams,
      pageNo,
      pageSize
    })
  }

  const builtFilters = searchService.buildFilterQueryParts(filters, filterOptions)
  return searchService.searchMediaResults({
    userId,
    query: '',
    whereConditions: [...scopeConditions, ...builtFilters.whereConditions],
    whereParams: [...scopeParams, ...builtFilters.whereParams],
    pageNo,
    pageSize
  })
}

function extractAppliedFilters(filters = {}) {
  return Object.keys(filters).filter((key) => {
    const value = filters[key]
    if (Array.isArray(value)) return value.length > 0
    return value && value !== '' && value !== 'all'
  })
}

/**
 * 分页获取筛选选项（用于滚动加载）
 * GET /search/filters?type=city&pageNo=1&pageSize=20
 * 可选 scope：scopeSource, scopeType, scopeAlbumId, scopeClusterId（与统一列表的 source/scope 一致，用于在当前维度下获取选项）
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetFilterOptionsPaginated(req, res) {
  const { userId } = req.user
  const {
    type,
    mediaType = 'all',
    scopeSource,
    scopeType,
    scopeAlbumId,
    scopeClusterId
  } = req.query
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 20 })

  if (!type || !['city', 'year', 'month', 'weekday'].includes(type)) {
    throwInvalidParametersError({
      messageType: 'error',
      message: 'type 参数必须是 city、year、month 或 weekday'
    })
  }

  let scopeConditions = []
  let scopeParams = []
  if (scopeSource) {
    const scope = {
      source: scopeSource,
      type: scopeType,
      albumId: scopeAlbumId,
      clusterId: scopeClusterId
    }
    const built = searchService.buildScopeConditions(scope, userId)
    scopeConditions = built.scopeConditions
    scopeParams = built.scopeParams
  }

  logger.info({
    message: `分页获取筛选选项: ${userId}`,
    details: { type, pageNo, pageSize, scopeSource: scopeSource || null }
  })

  const result = await searchService.getFilterOptionsPaginated({
    userId,
    type,
    pageNo,
    pageSize,
    mediaType: ['image', 'video'].includes(mediaType) ? mediaType : null,
    scopeConditions: scopeConditions.length ? scopeConditions : null,
    scopeParams: scopeParams.length ? scopeParams : null
  })

  res.sendResponse({
    data: result,
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED
  })
}

module.exports = {
  handleSearchMedias: asyncHandler(handleSearchMedias),
  handleGetFilterOptionsPaginated: asyncHandler(async (req, res) => {
    try {
      await handleGetFilterOptionsPaginated(req, res)
    } catch (err) {
      logger.error({
        message: '分页获取筛选选项失败',
        error: err.message,
        stack: err.stack
      })
      throw err
    }
  })
}
