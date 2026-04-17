/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类API控制器
 */

const faceClusterService = require('../services/faceCluster')
const {
  getClustersByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdsByClusterId,
  attachClusterCoverUrls
} = faceClusterService
const storageService = require('../services/storageService')
const logger = require('../utils/logger')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const asyncHandler = require('../utils/asyncHandler')
const { parsePositiveIntParam, parsePagination } = require('../utils/requestParams')

/**
 * 获取指定人物（cluster）下所有 face_embedding_id（用于前端「合并到其他人」时一次性移整人）
 * GET /face-clusters/:clusterId/face-embedding-ids
 */
async function getClusterFaceEmbeddingIds(req, res) {
  const { userId } = req.user
  const { clusterId } = req.params

  const clusterIdNum = parsePositiveIntParam(clusterId)

  const faceEmbeddingIds = getFaceEmbeddingIdsByClusterId(userId, clusterIdNum)

  res.sendResponse({
    data: { faceEmbeddingIds }
  })
}

/**
 * 获取用户的聚类列表（带分页、封面、时间范围）
 * GET /face-clusters?pageNo=1&pageSize=20
 */
async function getClusters(req, res) {
  const { userId } = req.user
  const { search } = req.query
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 20 })
  const searchVal = search && typeof search === 'string' ? search.trim() || null : null

  const result = getClustersByUserId(userId, {
    pageNo,
    pageSize,
    search: searchVal
  })

  logger.info({
    message: '人物列表查询结果',
    details: {
      userId,
      total: result.total,
      listLength: result.list?.length || 0,
      hasData: result.total > 0
    }
  })

  const listWithUrls = await attachClusterCoverUrls(result.list)

  res.sendResponse({
    data: {
      list: listWithUrls,
      total: result.total
    }
  })
}

/**
 * 获取最近使用的人物列表（用于 popover 第一屏，排序：最近使用 > 有名字 > 图片数量）
 * GET /face-clusters/recent?limit=5&excludeClusterId=123
 */
async function getRecentClusters(req, res) {
  const { userId } = req.user
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20)
  const excludeClusterId = req.query.excludeClusterId ? parseInt(req.query.excludeClusterId, 10) : null

  const result = getRecentClustersByUserId(userId, {
    limit,
    excludeClusterId: Number.isNaN(excludeClusterId) ? null : excludeClusterId
  })

  const listWithUrls = await attachClusterCoverUrls(result.list)

  res.sendResponse({ data: { list: listWithUrls, total: result.total } })
}

/**
 * 更新聚类名称
 * PATCH /face-clusters/:clusterId
 */
async function updateCluster(req, res) {
  const { userId } = req.user
  const { clusterId } = req.params
  const { name } = req.body

  if (name !== undefined && typeof name !== 'string' && name !== null) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }

  const clusterIdNum = parseInt(clusterId)
  if (name != null && String(name).trim() !== '') {
    const existingNames = getExistingPersonNames(userId, clusterIdNum)
    if (existingNames.includes(String(name).trim())) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.DUPLICATE_PERSON_NAME,
        messageType: 'warning'
      })
    }
  }

  const result = updateClusterName(userId, clusterIdNum, name || null)

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: 'error'
    })
  }

  res.sendResponse({
    data: {
      clusterId: parseInt(clusterId),
      name: name || null
    }
  })
}

/**
 * 将照片从一个聚类移动到另一个聚类（或创建新聚类）
 * POST /face-clusters/:clusterId/move-faces
 */
async function moveFaces(req, res) {
  const { userId } = req.user
  const { clusterId } = req.params
  const { faceEmbeddingIds, targetClusterId, newClusterName } = req.body

  if (!Array.isArray(faceEmbeddingIds) || faceEmbeddingIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }

  const invalidIds = faceEmbeddingIds.filter((id) => typeof id !== 'number' && !Number.isInteger(Number(id)))
  if (invalidIds.length > 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }

  if (targetClusterId !== null && targetClusterId !== undefined) {
    if (typeof targetClusterId !== 'number' && !Number.isInteger(Number(targetClusterId))) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }
  }

  const newName = newClusterName != null ? String(newClusterName).trim() : ''
  if (targetClusterId == null && newName !== '') {
    const existingNames = getExistingPersonNames(userId, null)
    if (existingNames.includes(newName)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.DUPLICATE_PERSON_NAME,
        messageType: 'warning'
      })
    }
  }

  const result = moveFacesToCluster(
    userId,
    parseInt(clusterId),
    faceEmbeddingIds.map((id) => parseInt(id)),
    targetClusterId ? parseInt(targetClusterId) : null,
    newClusterName || null
  )

  res.sendResponse({
    data: {
      affectedRows: result.affectedRows,
      targetClusterId: result.targetClusterId
    }
  })
}

/**
 * 恢复人物聚类默认封面
 * DELETE /face-clusters/:clusterId/cover
 */
async function restoreClusterCoverImage(req, res) {
  const { userId } = req.user
  const { clusterId } = req.params

  const clusterIdNum = parsePositiveIntParam(clusterId)

  const result = await faceClusterService.restoreDefaultCover(userId, clusterIdNum)

  if (!result) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: 'error'
    })
  }

  let coverImageUrl = null
  if (result.thumbnailStorageKey) {
    try {
      coverImageUrl = await storageService.getFileUrl(result.thumbnailStorageKey)
    } catch (error) {
      logger.error({
        message: `获取封面URL失败: faceEmbeddingId=${result.faceEmbeddingId}`,
        details: { error: error.message }
      })
    }
  }

  res.sendResponse({
    data: {
      clusterId: clusterIdNum,
      faceEmbeddingId: result.faceEmbeddingId,
      coverImageUrl
    }
  })
}

/**
 * 设置人物聚类封面
 * PATCH /face-clusters/:clusterId/cover
 */
async function setClusterCoverImage(req, res) {
  const { userId } = req.user
  const { clusterId } = req.params
  const { faceEmbeddingId } = req.body

  const faceEmbeddingIdNum = parsePositiveIntParam(faceEmbeddingId)

  const clusterIdNum = parsePositiveIntParam(clusterId)

  if (!verifyFaceEmbeddingInCluster(userId, clusterIdNum, faceEmbeddingIdNum)) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }

  const thumbnailStorageKey = await faceClusterService.generateThumbnailForFaceEmbedding(faceEmbeddingIdNum)
  if (!thumbnailStorageKey) {
    logger.warn({
      message: `无法生成人脸缩略图，拒绝设置封面: faceEmbeddingId=${faceEmbeddingIdNum}`,
      details: { userId, clusterId: clusterIdNum }
    })
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.PERSON_COVER_FACE_THUMBNAIL_UNAVAILABLE,
      messageType: 'error'
    })
  }

  const result = setClusterCover(userId, clusterIdNum, faceEmbeddingIdNum)

  if (result.error) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error',
      message: result.error
    })
  }

  if (result.affectedRows === 0 && !result.isDefaultCover) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: 'error'
    })
  }

  let coverImageUrl = null
  if (thumbnailStorageKey) {
    try {
      coverImageUrl = await storageService.getFileUrl(thumbnailStorageKey)
    } catch (error) {
      logger.error({
        message: `获取封面URL失败: faceEmbeddingId=${faceEmbeddingIdNum}`,
        details: { error: error.message }
      })
    }
  }

  res.sendResponse({
    data: {
      clusterId: clusterIdNum,
      faceEmbeddingId: faceEmbeddingIdNum,
      coverImageUrl
    }
  })
}

module.exports = {
  getClusters: asyncHandler(getClusters),
  getRecentClusters: asyncHandler(getRecentClusters),
  getClusterFaceEmbeddingIds: asyncHandler(getClusterFaceEmbeddingIds),
  updateCluster: asyncHandler(updateCluster),
  moveFaces: asyncHandler(moveFaces),
  setClusterCoverImage: asyncHandler(setClusterCoverImage),
  restoreClusterCoverImage: asyncHandler(restoreClusterCoverImage)
}
