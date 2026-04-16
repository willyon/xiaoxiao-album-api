/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能API控制器
 */

const CustomError = require('../errors/customError')
const { SUCCESS_CODES, ERROR_CODES } = require('../constants/messageCodes')
const searchService = require('../services/search')
const { addFullUrlToMedia } = require('../services/mediaService')
const faceClusterService = require('../services/faceCluster')
const logger = require('../utils/logger')

/**
 * 搜索/列表图片（统一接口）
 * POST /search/media
 * body: query?, filters?, pageNo, pageSize, clusterId?
 *       可选 scope：source?, type?, albumId?（传了 source 且不为 search 时在范围内列表/搜索；未传或 source=search 为全局搜索）
 */
async function handleSearchMedias(req, res, next) {
  try {
    const { userId } = req.user
    const { query, filters = {}, pageNo = 1, pageSize = 20, clusterId: clusterIdRaw, source, type, albumId } = req.body

    const clusterId = clusterIdRaw != null && clusterIdRaw !== '' ? parseInt(clusterIdRaw, 10) : null
    const validClusterId = Number.isNaN(clusterId) ? null : clusterId

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

    let searchResult

    if (hasScope) {
      const scope = { source, type, albumId, clusterId: validClusterId }
      const { scopeConditions, scopeParams } = searchService.buildScopeConditions(scope, userId)
      if (hasQuery) {
        searchResult = await searchService.searchMediaResults({
          userId,
          query: searchQuery,
          baseFilters: filters,
          filterOptions,
          scopeConditions,
          scopeParams,
          pageNo: parseInt(pageNo, 10),
          pageSize: parseInt(pageSize, 10)
        })
      } else {
        const filterBuilt = searchService.buildFilterQueryParts(filters, filterOptions)
        searchResult = await searchService.searchMediaResults({
          userId,
          query: '',
          whereConditions: [...scopeConditions, ...filterBuilt.whereConditions],
          whereParams: [...scopeParams, ...filterBuilt.whereParams],
          pageNo: parseInt(pageNo, 10),
          pageSize: parseInt(pageSize, 10)
        })
      }
      let resultsWithUrls = await addFullUrlToMedia(searchResult.list)
      if (source === 'people' && validClusterId != null && resultsWithUrls.length > 0) {
        const mediaIds = resultsWithUrls.map((item) => item.mediaId).filter((id) => id != null)
        const faceEmbeddingIdMap = faceClusterService.getFaceEmbeddingIdByMediaIdInCluster(userId, validClusterId, mediaIds)
        resultsWithUrls = resultsWithUrls.map((item) => ({
          ...item,
          faceEmbeddingId: faceEmbeddingIdMap.get(item.mediaId) ?? null
        }))
      }
      logger.info({
        message: `范围列表/搜索完成: ${userId}`,
        details: { source, resultCount: resultsWithUrls.length, total: searchResult.total }
      })
      return res.sendResponse({
        data: { list: resultsWithUrls, total: searchResult.total },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED
      })
    }

    // 全局搜索：有关键词时整句在 searchService 内解析（空格视为同一句内多线索，不拆成多次搜索）；无关键词时仅筛选列表
    if (hasQuery) {
      searchResult = await searchService.searchMediaResults({
        userId,
        query: searchQuery,
        baseFilters: filters,
        filterOptions,
        scopeConditions: [],
        scopeParams: [],
        pageNo: parseInt(pageNo, 10),
        pageSize: parseInt(pageSize, 10)
      })
    } else {
      const built = searchService.buildFilterQueryParts(filters, filterOptions)
      searchResult = await searchService.searchMediaResults({
        userId,
        query: '',
        whereConditions: built.whereConditions,
        whereParams: built.whereParams,
        pageNo: parseInt(pageNo, 10),
        pageSize: parseInt(pageSize, 10)
      })
    }

    const resultsWithUrls = await addFullUrlToMedia(searchResult.list)

    logger.info({
      message: `搜索完成: ${userId}`,
      details: {
        query,
        resultCount: resultsWithUrls.length,
        totalCount: searchResult.total,
        termCount: searchResult.stats?.termCount || 0,
        ftsCount: searchResult.stats?.ftsCount || 0,
        appliedFilters: Object.keys(filters).filter((key) => {
          const value = filters[key]
          if (Array.isArray(value)) return value.length > 0
          return value && value !== '' && value !== 'all'
        })
      }
    })

    res.sendResponse({
      data: {
        list: resultsWithUrls,
        total: searchResult.total
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED
    })
  } catch (error) {
    next(error)
  }
}

/**
 * 分页获取筛选选项（用于滚动加载）
 * GET /search/filters?type=city&pageNo=1&pageSize=20
 * 可选 scope：scopeSource, scopeType, scopeAlbumId, scopeClusterId（与统一列表的 source/scope 一致，用于在当前维度下获取选项）
 */
async function handleGetFilterOptionsPaginated(req, res, next) {
  try {
    const { userId } = req.user
    const {
      type,
      pageNo = 1,
      pageSize = 20,
      mediaType = 'all',
      scopeSource,
      scopeType,
      scopeAlbumId,
      scopeClusterId
    } = req.query

    if (!type || !['city', 'year', 'month', 'weekday'].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
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
      pageNo: parseInt(pageNo),
      pageSize: parseInt(pageSize),
      mediaType: ['image', 'video'].includes(mediaType) ? mediaType : null,
      scopeConditions: scopeConditions.length ? scopeConditions : null,
      scopeParams: scopeParams.length ? scopeParams : null
    })

    res.sendResponse({
      data: result,
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED
    })
  } catch (error) {
    logger.error({
      message: '分页获取筛选选项失败',
      error: error.message,
      stack: error.stack
    })
    next(error)
  }
}

module.exports = {
  handleSearchMedias,
  handleGetFilterOptionsPaginated
}
