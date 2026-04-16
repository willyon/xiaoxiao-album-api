/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 22:53:54
 * @Description: File description
 */
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const storageService = require('./storageService')
const { rebuildMediaEmbeddingDoc } = require('./mediaEmbeddingRebuildService')
const mediaModel = require('../models/mediaModel')
const cleanupModel = require('../models/cleanupModel')
const albumModel = require('../models/albumModel')
const favoriteService = require('./favoriteService')
const logger = require('../utils/logger')

// ========== 活跃的业务逻辑代码 ==========

/**
 * 重建 media_search / FTS / terms，并异步刷新视觉文本向量（与原先 mediaModel 内行为一致）。
 */
function rebuildMediaSearchDoc(mediaId) {
  const result = mediaModel.rebuildMediaSearchDoc(mediaId)
  Promise.resolve(rebuildMediaEmbeddingDoc(mediaId)).catch((error) => {
    logger.warn({
      message: '[rebuildMediaSearchDoc] rebuildMediaEmbeddingDoc failed',
      details: { error: error?.message || String(error) }
    })
  })
  return result
}

function selectMediaRowByHashForUser(opts) {
  return mediaModel.selectMediaRowByHashForUser(opts)
}

function listFailedMedias(opts) {
  return mediaModel.listFailedMedias(opts)
}

function listAllFailedCloudMedias(opts) {
  return mediaModel.listAllFailedCloudMedias(opts)
}

function countFailedMediasByStage(userId, opts) {
  return mediaModel.countFailedMediasByStage(userId, opts)
}

// ========== URL处理工具函数 ==========

// 通用的URL添加方法
async function _addFullUrls(items, type = 'image') {
  try {
    if (!items || !items.length) {
      return items
    }

    // 根据类型选择处理逻辑
    if (type === 'image') {
      // 处理图片/视频：生成高清图URL、缩略图URL、视频原片URL
      for (const item of items) {
        const needsOriginalUrl = item.mediaType === 'video' || !item.highResStorageKey
        if (item.highResStorageKey) {
          item.highResUrl = await storageService.getFileUrl(item.highResStorageKey)
          delete item.highResStorageKey
        }
        if (item.thumbnailStorageKey) {
          item.thumbnailUrl = await storageService.getFileUrl(item.thumbnailStorageKey)
          delete item.thumbnailStorageKey
        }
        if (needsOriginalUrl && item.originalStorageKey) {
          item.originalUrl = await storageService.getFileUrl(item.originalStorageKey)
          delete item.originalStorageKey
        }
      }
    } else if (type === 'group') {
      // 处理分组：生成封面图片URL
      for (const item of items) {
        if (item.latestImagekey) {
          item.latestImageUrl = await storageService.getFileUrl(item.latestImagekey)
          delete item.latestImagekey // 删除原始字段
        }
      }
    }

    return items
  } catch (error) {
    logger.error({
      message: `批量获取${type === 'image' ? '图片' : '分组封面图片'}URL失败`,
      details: { error: error.message }
    })
  }
}

// 为图片数据添加完整URL的方法
// 注意：isFavorite 字段现在直接从数据库查询返回，无需额外处理
async function addFullUrlToMedia(data) {
  return await _addFullUrls(data, 'image')
}

// 为分组数据添加完整URL的方法
async function _addFullUrlToGroupCover(groups) {
  return await _addFullUrls(groups, 'group')
}

// ========== 图片业务逻辑函数 ==========

// 保存新图片信息到数据库
async function saveNewMedia(imageData) {
  // 参数校验
  const { userId, imageHash, thumbnailStorageKey } = imageData
  if (!userId || !imageHash) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  if (!thumbnailStorageKey) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  try {
    const result = await mediaModel.insertMedia(imageData)
    if (result.affectedRows === 0) {
      throw new CustomError({
        httpStatus: 500,
        messageCode: ERROR_CODES.DATA_INSERT_FAILED,
        messageType: 'error'
      })
    }
    return result
  } catch (error) {
    throw error
  }
}

// 保存已处理的图片元数据（包含错误处理和日志记录）
async function saveProcessedMediaMetadata(imageData) {
  try {
    const result = await mediaModel.updateMediaMetadata(imageData)
    return result
  } catch (error) {
    logger.error({
      message: '更新图片元数据失败',
      details: { imageData, error: error.message }
    })
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, '更新图片元数据失败')
  }
}

/** 仅支持终态 success | failed（与 updateMetaPipelineStatusByHash 一致，不支持清空为 NULL）。 */
async function setMetaPipelineStatus({ userId, imageHash, metaPipelineStatus }) {
  try {
    return mediaModel.updateMetaPipelineStatusByHash({ userId, imageHash, metaPipelineStatus })
  } catch (error) {
    logger.warn({
      message: '更新 meta_pipeline_status 失败',
      details: { userId, imageHash, metaPipelineStatus, error: error.message }
    })
    return { affectedRows: 0 }
  }
}

// 获取用户图片哈希列表
async function getUserMediaHashes(userId) {
  try {
    const hashes = await mediaModel.selectHashesByUserId(userId)
    return hashes
  } catch (error) {
    logger.error({
      message: '获取用户图片哈希失败',
      details: { userId, error: error.message }
    })
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, '获取用户图片哈希失败')
  }
}

// ========== 图片查询服务函数 ==========

/**
 * 分页获取用户模糊图列表（is_blurry = 1），用于清理页模糊图 tab
 * @returns {{ list: Array<{ mediaId, thumbnailUrl, highResUrl, capturedAt, createdAt, isFavorite }>, total: number }}
 */
async function getBlurryMedias({ userId, pageNo = 1, pageSize = 20 }) {
  const safePageSize = Math.max(Number(pageSize) || 20, 1)
  const queryResult = mediaModel.getMediasByBlurry({
    userId,
    pageNo,
    pageSize: safePageSize
  })
  const total = queryResult.total
  const list = await Promise.all(
    (queryResult.data || []).map(async (img) => {
      let thumbnailUrl = null
      let highResUrl = null
      if (img.thumbnailStorageKey != null) {
        try {
          thumbnailUrl = await storageService.getFileUrl(img.thumbnailStorageKey)
        } catch (e) {
          logger.warn({ message: '获取模糊图缩略图 URL 失败', details: { error: e?.message } })
        }
      }
      if (img.highResStorageKey != null) {
        try {
          highResUrl = await storageService.getFileUrl(img.highResStorageKey)
        } catch (e) {
          logger.warn({ message: '获取模糊图高清 URL 失败', details: { error: e?.message } })
        }
      }
      return {
        mediaId: img.mediaId,
        thumbnailUrl,
        highResUrl,
        capturedAt: img.capturedAt,
        createdAt: img.createdAt,
        isFavorite: img.isFavorite
      }
    })
  )
  return { list, total }
}

// 分页获取用户某年份图片
// albumId: 对于时间相册，实际上是 year_key (如 "2024")
// clusterId: 可选，用于查询特定人物的某年份照片
async function getMediasByYear({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  try {
    const result = await mediaModel.selectMediasByYear({
      pageNo,
      pageSize,
      albumId,
      userId,
      clusterId
    })

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToMedia(result.data)

    return result
  } catch (error) {
    logger.error({
      message: '分页获取用户某年份图片失败',
      details: { pageNo, pageSize, albumId, userId, clusterId, error: error.message }
    })
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, '获取用户图片失败')
  }
}

// 分页获取用户某月份图片
// albumId: 对于时间相册，实际上是 month_key (如 "2024-01")
// clusterId: 可选，用于查询特定人物的某月份照片
async function getMediasByMonth({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  try {
    const result = await mediaModel.selectMediasByMonth({
      pageNo,
      pageSize,
      albumId,
      userId,
      clusterId
    })

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToMedia(result.data)

    return result
  } catch (error) {
    logger.error({
      message: '分页获取用户某月份图片失败',
      details: { pageNo, pageSize, albumId, userId, clusterId, error: error.message }
    })
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, '获取用户图片失败')
  }
}

// 分页获取用户某日期图片
// albumId: 对于时间相册，实际上是 date_key (如 "2024-01-15")
async function getMediasByDate({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await mediaModel.selectMediasByDate({ pageNo, pageSize, albumId, userId })

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToMedia(result.data)

    return result
  } catch (error) {
    logger.error({
      message: '分页获取用户某日期图片失败',
      details: { pageNo, pageSize, albumId, userId, error: error.message }
    })
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, '获取用户图片失败')
  }
}

// 分页获取用户某地点图片
// albumId: 城市名称或 'unknown'
async function getMediasByCity({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await mediaModel.selectMediasByCity({ pageNo, pageSize, albumId, userId })

    result.data = await addFullUrlToMedia(result.data)

    return result
  } catch (error) {
    logger.error({
      message: '分页获取用户某地点图片失败',
      details: { pageNo, pageSize, albumId, userId, error: error.message }
    })
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, '获取用户图片失败')
  }
}

// 按年份获取分组信息
async function getGroupsByYear({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  try {
    const queryResult = await mediaModel.selectGroupsByYear({ pageNo, pageSize, userId })

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data)
    }

    return queryResult
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: 'error'
    })
  }
}

// 按月份获取分组信息
async function getGroupsByMonth({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  try {
    const queryResult = await mediaModel.selectGroupsByMonth({ pageNo, pageSize, userId })

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data)
    }

    return queryResult
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_MONTH,
      messageType: 'error'
    })
  }
}

// 按地点获取分组信息
async function getGroupsByCity({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  try {
    const queryResult = await mediaModel.selectGroupsByCity({ pageNo, pageSize, userId })
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data)
    }
    return queryResult
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: 'error'
    })
  }
}

// 按日期获取分组信息
async function getGroupsByDate({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  try {
    const queryResult = await mediaModel.selectGroupsByDate({ pageNo, pageSize, userId })

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data)
    }

    return queryResult
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_DATE,
      messageType: 'error'
    })
  }
}

// 部分更新图片信息（仅用于 favorite 字段，更新 images.is_favorite）
async function patchMedia({ userId, imageId, patchData }) {
  if (patchData.favorite !== undefined || patchData.isFavorite !== undefined) {
    const isFavorite = patchData.favorite !== undefined ? patchData.favorite : patchData.isFavorite
    return await favoriteService.toggleFavoriteMedia({
      userId,
      imageId,
      isFavorite
    })
  }

  throw new CustomError({
    httpStatus: 400,
    messageCode: ERROR_CODES.INVALID_PARAMETERS,
    messageType: 'warning',
    message: '目前只支持更新 favorite 字段'
  })
}

// 删除图片（软删除，移至回收站）
// 这是核心的删除方法，包含通用的删除逻辑
async function deleteMedias({ userId, imageIds }) {
  // 规范化 ID 列表
  const normalizedIds = Array.isArray(imageIds) ? imageIds.map((id) => parseInt(id)).filter((id) => !isNaN(id)) : []

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }

  // 验证图片权限
  const images = cleanupModel.selectMediasByIds(normalizedIds)
  if (images.length !== normalizedIds.length) {
    logger.warn({
      message: '删除图片时，部分图片未找到',
      details: {
        userId,
        requestedIds: normalizedIds,
        foundIds: images.map((img) => img.id),
        missingIds: normalizedIds.filter((id) => !images.some((img) => img.id === id))
      }
    })
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: 'warning'
    })
  }

  // 验证用户权限
  const unauthorized = images.some((image) => image.user_id !== userId)
  if (unauthorized) {
    throw new CustomError({
      httpStatus: 403,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: 'error'
    })
  }

  const now = Date.now()

  // 执行删除操作：软删除，标记 deleted_at
  cleanupModel.markMediasDeleted(normalizedIds, now)

  // 同步 media_search / media_search_fts（软删除后移除搜索文档）
  normalizedIds.forEach((id) => {
    try {
      rebuildMediaSearchDoc(id)
    } catch (error) {
      logger.warn({
        message: '软删除后同步搜索索引失败',
        details: { imageId: id, error: error.message }
      })
    }
  })

  // 更新包含这些图片的相册统计（图片数量、封面）
  albumModel.updateAlbumsStatsForMedias(normalizedIds)

  logger.info({
    message: 'image.delete.completed',
    details: {
      userId,
      imageIds: normalizedIds,
      timestamp: now
    }
  })

  return {
    deletedCount: normalizedIds.length
  }
}

/**
 * 获取单张图片的下载信息
 */
async function getMediaDownloadInfo({ userId, imageId }) {
  const image = mediaModel.getMediaDownloadInfo({ userId, imageId })
  if (!image) {
    return null
  }
  return image
}

/**
 * 批量获取图片的下载信息
 */
async function getMediasDownloadInfo({ userId, imageIds }) {
  const images = mediaModel.getMediasDownloadInfo({ userId, imageIds })
  return images
}

module.exports = {
  // ========== 媒体业务逻辑函数 ==========
  saveNewMedia,
  saveProcessedMediaMetadata,
  setMetaPipelineStatus,
  getUserMediaHashes,
  rebuildMediaSearchDoc,
  selectMediaRowByHashForUser,
  listFailedMedias,
  listAllFailedCloudMedias,
  countFailedMediasByStage,

  // ========== 媒体查询服务函数 ==========
  getBlurryMedias,
  getMediasByYear,
  getMediasByMonth,
  getMediasByDate,
  getMediasByCity,
  getGroupsByYear,
  getGroupsByMonth,
  getGroupsByDate,
  getGroupsByCity,
  addFullUrlToMedia,

  // ========== 媒体 CRUD 服务函数 ==========
  patchMedia, // 仅用于 favorite 字段更新
  deleteMedias,
  // ========== 媒体下载服务函数 ==========
  getMediaDownloadInfo,
  getMediasDownloadInfo
}
