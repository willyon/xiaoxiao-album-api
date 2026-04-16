/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册API控制器
 */
const albumService = require('../services/albumService')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')

/**
 * 创建相册
 */
async function createAlbum(req, res, next) {
  try {
    const userId = req.user.userId
    const { name, description } = req.body

    const album = await albumService.createAlbum({
      userId,
      name,
      description
    })

    res.sendResponse({ data: album })
  } catch (error) {
    next(error)
  }
}

/**
 * 获取相册详情
 */
async function getAlbumById(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params

    const album = await albumService.getAlbumById({
      albumId: parseInt(albumId),
      userId
    })

    if (!album) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: 'error'
      })
    }

    res.sendResponse({ data: album })
  } catch (error) {
    next(error)
  }
}

/**
 * 更新相册
 */
async function updateAlbum(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params
    const { name, description, coverImageId } = req.body

    const album = await albumService.updateAlbum({
      userId,
      albumId: parseInt(albumId),
      name,
      description,
      coverImageId: coverImageId ? parseInt(coverImageId) : undefined
    })

    res.sendResponse({ data: album })
  } catch (error) {
    next(error)
  }
}

/**
 * 删除相册
 */
async function deleteAlbum(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params

    await albumService.deleteAlbum({
      userId,
      albumId: parseInt(albumId)
    })

    res.sendResponse({ data: { success: true } })
  } catch (error) {
    next(error)
  }
}

/**
 * 获取自定义相册列表
 * GET /api/albums?pageNo=1&pageSize=20&search=xxx&excludeAlbumId=123
 */
async function getCustomAlbums(req, res, next) {
  try {
    const userId = req.user.userId
    const { pageNo, pageSize, search, excludeAlbumId } = req.query
    const excludeId = excludeAlbumId ? parseInt(excludeAlbumId, 10) : null

    const result = await albumService.getAlbumsList({
      userId,
      pageNo: pageNo || 1,
      pageSize: pageSize || 20,
      search: search || null,
      excludeAlbumId: Number.isNaN(excludeId) ? null : excludeId
    })

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * 获取最近使用的相册（前 limit 个，用于「添加到相册」递进式弹窗第一屏）
 * GET /api/albums/recent?limit=8&excludeAlbumId=123
 */
async function getRecentAlbums(req, res, next) {
  try {
    const userId = req.user.userId
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20)
    const excludeAlbumId = req.query.excludeAlbumId ? parseInt(req.query.excludeAlbumId, 10) : null

    const result = await albumService.getRecentAlbumsList({
      userId,
      limit,
      excludeAlbumId: Number.isNaN(excludeAlbumId) ? null : excludeAlbumId
    })
    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * 添加图片到相册（albumId 为数字相册 ID）
 * Body: { mediaIds: number[] }
 */
async function addMediasToAlbum(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params
    const { mediaIds } = req.body

    const albumIdNum = parseInt(albumId, 10)
    if (Number.isNaN(albumIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const result = await albumService.addMediasToAlbum({
      userId,
      albumId: albumIdNum,
      mediaIds: mediaIds.map((id) => parseInt(id, 10))
    })

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * 从相册中移除图片（albumId 为数字相册 ID）
 * Body: { mediaIds: number[] }
 */
async function removeMediasFromAlbum(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params
    const { mediaIds } = req.body

    const albumIdNum = parseInt(albumId, 10)
    if (Number.isNaN(albumIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const result = await albumService.removeMediasFromAlbum({
      userId,
      albumId: albumIdNum,
      mediaIds: mediaIds.map((id) => parseInt(id, 10))
    })

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * 设置相册封面图片
 */
async function setAlbumCover(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params
    const { mediaId } = req.body
    const mediaIdNum = parseInt(mediaId, 10)
    if (!Number.isInteger(mediaIdNum) || mediaIdNum < 1) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const result = await albumService.setAlbumCover({
      userId,
      albumId: parseInt(albumId),
      mediaId: mediaIdNum
    })

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * 恢复相册默认封面（最近加入的一张图/视频，与系统自动封面规则一致）
 * DELETE /api/albums/:albumId/cover
 */
async function restoreAlbumCover(req, res, next) {
  try {
    const userId = req.user.userId
    const { albumId } = req.params
    const albumIdNum = parseInt(albumId, 10)
    if (Number.isNaN(albumIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const result = await albumService.restoreAlbumCover({
      userId,
      albumId: albumIdNum
    })

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

module.exports = {
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  getCustomAlbums,
  getRecentAlbums,
  addMediasToAlbum,
  removeMediasFromAlbum,
  setAlbumCover,
  restoreAlbumCover
}
