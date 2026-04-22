/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 22:53:54
 * @Description: File description
 */
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const { rebuildMediaEmbeddingDoc } = require('./mediaEmbeddingRebuildService')
const mediaModel = require('../models/mediaModel')
const cleanupModel = require('../models/cleanupModel')
const albumModel = require('../models/albumModel')
const favoriteService = require('./favoriteService')
const logger = require('../utils/logger')
const { normalizeNumericIds } = require('../utils/normalizeNumericIds')
const { hydrateMediaUrls, resolveStorageKeyUrl } = require('../utils/mediaUrlHydrator')

// ========== 活跃的业务逻辑代码 ==========

/**
 * 重建 media_search / FTS / terms，并异步刷新视觉文本向量（与原先 mediaModel 内行为一致）。
 * @param {number|string} mediaId - 媒体 ID。
 * @returns {any} model 重建结果。
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

/**
 * 按文件哈希查询用户媒体行。
 * @param {object} opts - 查询参数。
 * @returns {object|null} 媒体行或 null。
 */
function selectMediaRowByHashForUser(opts) {
  return mediaModel.selectMediaRowByHashForUser(opts)
}

/**
 * 列举处理失败媒体。
 * @param {object} opts - 查询参数。
 * @returns {Array<object>} 失败媒体列表。
 */
function listFailedMedias(opts) {
  return mediaModel.listFailedMedias(opts)
}

/**
 * 列举全部云阶段失败媒体。
 * @param {object} opts - 查询参数。
 * @returns {Array<object>} 失败媒体列表。
 */
function listAllFailedCloudMedias(opts) {
  return mediaModel.listAllFailedCloudMedias(opts)
}

/**
 * 统计各阶段失败数量。
 * @param {number|string} userId - 用户 ID。
 * @param {object} opts - 统计选项。
 * @returns {object} 统计结果。
 */
function countFailedMediasByStage(userId, opts) {
  return mediaModel.countFailedMediasByStage(userId, opts)
}

// ========== URL处理工具函数 ==========

// 通用的URL添加方法
/**
 * 为媒体或分组数据补全可访问 URL。
 * @param {Array<object>} items - 原始数据列表。
 * @param {'image'|'group'} [type='image'] - 数据类型。
 * @returns {Promise<Array<object>|undefined>} 处理后的数据列表。
 */
async function _addFullUrls(items, type = 'image') {
  try {
    if (!items || !items.length) {
      return items
    }

    // 根据类型选择处理逻辑
    if (type === 'image') {
      return await hydrateMediaUrls(items, { dropStorageKeys: true })
    } else if (type === 'group') {
      // 处理分组：生成封面图片URL
      for (const item of items) {
        if (item.latestImagekey) {
          item.latestImageUrl = await resolveStorageKeyUrl(item.latestImagekey, '获取分组封面 URL 失败')
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
/**
 * 为媒体列表补齐可访问/导出用的完整 URL 字段。
 * @param {Array<object>} data - 媒体数据列表。
 * @returns {Promise<Array<object>|undefined>} 补齐后的数据列表。
 */
async function addFullUrlToMedia(data) {
  return await _addFullUrls(data, 'image')
}

// 为分组数据添加完整URL的方法
/**
 * 为分组数据补齐封面 URL。
 * @param {Array<object>} groups - 分组列表。
 * @returns {Promise<Array<object>|undefined>} 补齐后的分组列表。
 */
async function _addFullUrlToGroupCover(groups) {
  return await _addFullUrls(groups, 'group')
}

function _assertValidGroupQueryParams({ userId, pageNo, pageSize }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
}

async function _fetchGroupedMedia({ userId, pageNo, pageSize, withFullUrls, selectFn, errorCode }) {
  _assertValidGroupQueryParams({ userId, pageNo, pageSize })
  try {
    const queryResult = await selectFn({ pageNo, pageSize, userId })
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data)
    }
    return queryResult
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: errorCode,
      messageType: 'error'
    })
  }
}

// ========== 图片业务逻辑函数 ==========

// 保存新图片信息到数据库
/**
 * 新增媒体基础记录。
 * @param {object} imageData - 媒体基础信息。
 * @returns {Promise<any>} 插入结果。
 */
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
  const result = await mediaModel.insertMedia(imageData)
  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_INSERT_FAILED,
      messageType: 'error'
    })
  }
  return result
}

// 保存已处理的图片元数据（包含错误处理和日志记录）
/**
 * 保存媒体处理后的元数据。
 * @param {object} imageData - 元数据载荷。
 * @returns {Promise<any>} 更新结果。
 */
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
/**
 * 设置媒体 meta 流水线状态。
 * @param {{userId:number|string,imageHash:string,metaPipelineStatus:'success'|'failed'}} params - 状态参数。
 * @returns {Promise<{affectedRows:number}|any>} 更新结果。
 */
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
/**
 * 查询用户全部媒体哈希。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<Array<string>>} 哈希列表。
 */
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
 * @param {{userId:number|string,pageNo?:number,pageSize?:number}} params - 查询参数。
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
  const hydrated = await hydrateMediaUrls(queryResult.data || [])
  const list = hydrated.map((img) => ({
    mediaId: img.mediaId,
    thumbnailUrl: img.thumbnailUrl,
    highResUrl: img.highResUrl,
    capturedAt: img.capturedAt,
    createdAt: img.createdAt,
    isFavorite: img.isFavorite
  }))
  return { list, total }
}

// 按年份获取分组信息
/**
 * 按年份分页获取媒体分组。
 * @param {{userId:number|string,pageNo?:number,pageSize?:number,withFullUrls?:boolean}} params - 查询参数。
 * @returns {Promise<{data:Array<object>,total:number}>} 分组数据与总数。
 */
async function getGroupsByYear({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  return _fetchGroupedMedia({
    userId,
    pageNo,
    pageSize,
    withFullUrls,
    selectFn: mediaModel.selectGroupsByYear,
    errorCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR
  })
}

// 按月份获取分组信息
/**
 * 按月份分页获取媒体分组。
 * @param {{userId:number|string,pageNo?:number,pageSize?:number,withFullUrls?:boolean}} params - 查询参数。
 * @returns {Promise<{data:Array<object>,total:number}>} 分组数据与总数。
 */
async function getGroupsByMonth({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  return _fetchGroupedMedia({
    userId,
    pageNo,
    pageSize,
    withFullUrls,
    selectFn: mediaModel.selectGroupsByMonth,
    errorCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_MONTH
  })
}

// 按地点获取分组信息
/**
 * 按地点分页获取媒体分组。
 * @param {{userId:number|string,pageNo?:number,pageSize?:number,withFullUrls?:boolean}} params - 查询参数。
 * @returns {Promise<{data:Array<object>,total:number}>} 分组数据与总数。
 */
async function getGroupsByCity({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  return _fetchGroupedMedia({
    userId,
    pageNo,
    pageSize,
    withFullUrls,
    selectFn: mediaModel.selectGroupsByCity,
    errorCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR
  })
}

// 按日期获取分组信息
/**
 * 按日期分页获取媒体分组。
 * @param {{userId:number|string,pageNo?:number,pageSize?:number,withFullUrls?:boolean}} params - 查询参数。
 * @returns {Promise<{data:Array<object>,total:number}>} 分组数据与总数。
 */
async function getGroupsByDate({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  return _fetchGroupedMedia({
    userId,
    pageNo,
    pageSize,
    withFullUrls,
    selectFn: mediaModel.selectGroupsByDate,
    errorCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_DATE
  })
}

// 部分更新图片信息（仅用于 favorite 字段，更新 images.is_favorite）
/**
 * 更新媒体局部字段（当前仅支持 favorite）。
 * @param {{userId:number|string,mediaId:number|string,patchData:object}} params - 更新参数。
 * @returns {Promise<any>} 更新结果。
 */
async function patchMedia({ userId, mediaId, patchData }) {
  if (patchData.favorite !== undefined || patchData.isFavorite !== undefined) {
    const isFavorite = patchData.favorite !== undefined ? patchData.favorite : patchData.isFavorite
    return await favoriteService.toggleFavoriteMedia({
      userId,
      mediaId,
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
/**
 * 批量软删除媒体并同步关联索引统计。
 * @param {{userId:number|string,mediaIds:Array<number|string>}} params - 删除参数。
 * @returns {Promise<{deletedCount:number}>} 删除结果。
 */
async function deleteMedias({ userId, mediaIds }) {
  // 规范化 ID 列表
  const normalizedIds = normalizeNumericIds(mediaIds)

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
        details: { mediaId: id, error: error.message }
      })
    }
  })

  // 更新包含这些图片的相册统计（图片数量、封面）
  albumModel.updateAlbumsStatsForMedias(normalizedIds)

  logger.info({
    message: 'image.delete.completed',
    details: {
      userId,
      mediaIds: normalizedIds,
      timestamp: now
    }
  })

  return {
    deletedCount: normalizedIds.length
  }
}

/**
 * 获取单张图片的导出用信息
 * @param {{userId:number|string,mediaId:number|string}} params - 查询参数。
 * @returns {Promise<object|null>} 导出用信息或 null。
 */
async function getMediaExportInfo({ userId, mediaId }) {
  const image = mediaModel.getMediaExportInfo({ userId, mediaId })
  if (!image) {
    return null
  }
  return image
}

/**
 * 批量获取图片的导出用信息
 * @param {{userId:number|string,mediaIds:Array<number|string>}} params - 查询参数。
 * @returns {Promise<Array<object>>} 导出用信息列表。
 */
async function getMediasExportInfo({ userId, mediaIds }) {
  const images = mediaModel.getMediasExportInfo({ userId, mediaIds })
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
  getGroupsByYear,
  getGroupsByMonth,
  getGroupsByDate,
  getGroupsByCity,
  addFullUrlToMedia,

  // ========== 媒体 CRUD 服务函数 ==========
  patchMedia, // 仅用于 favorite 字段更新
  deleteMedias,
  // ========== 媒体导出服务函数 ==========
  getMediaExportInfo,
  getMediasExportInfo
}
