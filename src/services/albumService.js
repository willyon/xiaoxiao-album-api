/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册业务逻辑服务
 */
const albumModel = require('../models/albumModel')
const mediaModel = require('../models/mediaModel')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const { resolveStorageKeyUrl } = require('../utils/mediaUrlHydrator')

function _throwAlbumNotFound() {
  throw new CustomError({
    httpStatus: 404,
    messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
    messageType: 'error',
    message: '相册不存在'
  })
}

function _assertAlbumOwned(userId, albumId) {
  const album = albumModel.getAlbumById({ albumId, userId })
  if (!album) _throwAlbumNotFound()
  return album
}

function _validateAlbumName(name) {
  if (!name || name.trim().length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning',
      message: '相册名称不能为空'
    })
  }
  if (name.length > 50) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning',
      message: '相册名称不能超过50个字符'
    })
  }
}

function _assertAlbumNameUnique(userId, normalizedName, excludeAlbumId = null) {
  const existingAlbums = albumModel.getAlbumsByUserId({ userId })
  const nameExists = existingAlbums.some((album) => {
    if (excludeAlbumId != null && String(album.albumId) === String(excludeAlbumId)) return false
    return album.name === normalizedName
  })
  if (nameExists) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.DUPLICATE_ENTRY,
      messageType: 'warning',
      message: '相册名称已存在'
    })
  }
}

async function _withAlbumCoverAndTimeRange(album) {
  const coverImageUrl = await _getAlbumCoverImageUrl(album.coverImageId)
  const timeRange = albumModel.getAlbumTimeRange(album.albumId)
  return {
    ...album,
    coverImageUrl,
    timeRange: timeRange || undefined
  }
}

/**
 * 根据封面图片 ID 获取封面 URL。
 * @param {number|string|null|undefined} coverImageId - 封面媒体 ID。
 * @returns {Promise<string|null>} 封面 URL。
 */
async function _getAlbumCoverImageUrl(coverImageId) {
  if (!coverImageId) return null
  const coverImage = await _getMediaById(coverImageId)
  return resolveStorageKeyUrl(coverImage?.thumbnailStorageKey, '获取相册封面 URL 失败')
}

/**
 * 获取最近使用的相册列表（前 limit 个，按 max(created_at, last_used_at) 倒序，含封面 URL）
 * excludeAlbumId 可选，排除该相册（如当前相册）；返回 total 为排除后的相册总数，用于前端判断是否显示「选择其他相册」
 * @param {{userId:number|string,limit?:number,excludeAlbumId?:number|string|null}} params - 查询参数。
 * @returns {Promise<{list:Array<object>,total:number}>} 最近相册列表与总数。
 */
async function getRecentAlbumsList({ userId, limit = 8, excludeAlbumId = null }) {
  const albums = albumModel.getRecentAlbumsByUserId({ userId, limit, excludeAlbumId })
  const total = albumModel.getAlbumsCountByUserId({ userId, excludeAlbumId })

  const albumsWithCover = await Promise.all(
    albums.map((album) => _withAlbumCoverAndTimeRange(album))
  )

  return { list: albumsWithCover, total }
}

/**
 * 获取用户的自定义相册列表（包含封面图片URL）
 * excludeAlbumId 可选，排除该相册（如当前相册）
 * @param {{userId:number|string,pageNo?:number,pageSize?:number,search?:string|null,excludeAlbumId?:number|string|null}} params - 查询参数。
 * @returns {Promise<{list:Array<object>,total:number}>} 相册列表与总数。
 */
async function getAlbumsList({ userId, pageNo = 1, pageSize = 20, search = null, excludeAlbumId = null }) {
  const allAlbums = albumModel.getAlbumsByUserId({ userId, search, excludeAlbumId })

  // 分页处理
  const total = allAlbums.length
  const offset = (pageNo - 1) * pageSize
  const albums = allAlbums.slice(offset, offset + pageSize)

  // 按需更新封面：如果相册有图片但没有封面，自动更新封面
  albums.forEach((album) => {
    if (!album.coverImageId && album.mediaCount > 0) {
      // 封面为空但相册有图片，更新封面为最新添加的图片
      albumModel.updateAlbumCover(album.albumId)
      // 获取更新后的封面ID
      album.coverImageId = albumModel.getAlbumCoverMediaId(album.albumId)
    }
  })

  // 为每个相册添加封面图片URL与整本相册时间范围
  const albumsWithCover = await Promise.all(
    albums.map((album) => _withAlbumCoverAndTimeRange(album))
  )

  return {
    list: albumsWithCover,
    total
  }
}

/**
 * 创建相册
 * @param {{userId:number|string,name:string,description?:string}} params - 创建参数。
 * @returns {Promise<object>} 创建后的相册对象。
 */
async function createAlbum({ userId, name, description }) {
  _validateAlbumName(name)
  _assertAlbumNameUnique(userId, name.trim())

  const result = albumModel.createAlbum({
    userId,
    name: name.trim(),
    description: description?.trim() || null
  })

  return albumModel.getAlbumById({
    albumId: result.albumId,
    userId
  })
}

/**
 * 更新相册
 * @param {{userId:number|string,albumId:number|string,name?:string,description?:string,coverImageId?:number|string}} params - 更新参数。
 * @returns {Promise<object>} 更新后的相册对象。
 */
async function updateAlbum({ userId, albumId, name, description, coverImageId }) {
  const album = _assertAlbumOwned(userId, albumId)

  // 如果更新名称，检查名称是否已存在
  if (name !== undefined && name !== album.name) {
    _validateAlbumName(name)
    _assertAlbumNameUnique(userId, name.trim(), albumId)
  }

  // 如果设置封面，验证图片是否在相册中
  if (coverImageId !== undefined) {
    const isInAlbum = albumModel.isMediaInAlbum({ albumId, mediaId: coverImageId })
    if (!isInAlbum) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'warning',
        message: '封面图片必须属于该相册'
      })
    }
  }

  const result = albumModel.updateAlbum({
    albumId,
    userId,
    name: name?.trim(),
    description: description?.trim(),
    coverImageId
  })

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_UPDATE_FAILED,
      messageType: 'error'
    })
  }

  // 返回更新后的相册信息（包含封面图片URL）
  const updatedAlbum = albumModel.getAlbumById({ albumId, userId })
  const coverImageUrl = await _getAlbumCoverImageUrl(updatedAlbum.coverImageId)

  return {
    ...updatedAlbum,
    coverImageUrl
  }
}

/**
 * 删除相册
 * @param {{userId:number|string,albumId:number|string}} params - 删除参数。
 * @returns {Promise<{success:true}>} 删除结果。
 */
async function deleteAlbum({ userId, albumId }) {
  _assertAlbumOwned(userId, albumId)

  const result = albumModel.deleteAlbum({ albumId, userId })

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_DELETE_FAILED,
      messageType: 'error'
    })
  }

  return { success: true }
}

/**
 * 添加图片到相册
 * @param {{userId:number|string,albumId:number|string,mediaIds:Array<number|string>}} params - 添加参数。
 * @returns {Promise<any>} model 返回结果。
 */
async function addMediasToAlbum({ userId, albumId, mediaIds }) {
  _assertAlbumOwned(userId, albumId)

  // 验证图片存在且属于当前用户
  // TODO: 添加图片验证逻辑（可以调用 mediaModel 检查）

  const result = albumModel.addMediasToAlbum({ albumId, mediaIds })

  return result
}

/**
 * 从相册中移除图片
 * @param {{userId:number|string,albumId:number|string,mediaIds:Array<number|string>}} params - 移除参数。
 * @returns {Promise<any>} model 返回结果。
 */
async function removeMediasFromAlbum({ userId, albumId, mediaIds }) {
  _assertAlbumOwned(userId, albumId)

  const result = albumModel.removeMediasFromAlbum({ albumId, mediaIds })

  return result
}

/**
 * 设置相册封面图片
 * @param {{userId:number|string,albumId:number|string,mediaId:number|string}} params - 设置参数。
 * @returns {Promise<{albumId:number,coverImageId:number|null,coverImageUrl:string|null}>} 封面设置结果。
 */
async function setAlbumCover({ userId, albumId, mediaId }) {
  _assertAlbumOwned(userId, albumId)

  // 验证媒体是否在相册中（media 主键 id）
  const isInAlbum = albumModel.isMediaInAlbum({ albumId, mediaId })
  if (!isInAlbum) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning',
      message: '封面图片必须属于该相册'
    })
  }

  const result = albumModel.setAlbumCover({ albumId, mediaId })

  if (result.affectedRows === 0) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_UPDATE_FAILED,
      messageType: 'error'
    })
  }

  // 获取更新后的相册信息
  const updatedAlbum = albumModel.getAlbumById({ albumId, userId })
  const coverImageUrl = await _getAlbumCoverImageUrl(updatedAlbum.coverImageId)

  return {
    albumId: updatedAlbum.albumId,
    coverImageId: updatedAlbum.coverImageId,
    coverImageUrl
  }
}

/**
 * 恢复相册默认封面：与「添加/移除媒体后」一致，取相册内最近加入的一张图片或视频（见 albumModel.updateAlbumCover）
 * @param {{userId:number|string,albumId:number|string}} params - 恢复参数。
 * @returns {Promise<{albumId:number,coverImageId:number|null,coverImageUrl:string|null}>} 恢复结果。
 */
async function restoreAlbumCover({ userId, albumId }) {
  _assertAlbumOwned(userId, albumId)

  albumModel.updateAlbumCover(albumId)

  const updatedAlbum = albumModel.getAlbumById({ albumId, userId })
  const coverImageUrl = await _getAlbumCoverImageUrl(updatedAlbum.coverImageId)

  return {
    albumId: updatedAlbum.albumId,
    coverImageId: updatedAlbum.coverImageId,
    coverImageUrl
  }
}

/**
 * 获取相册详情（包含封面图片URL）
 * @param {{userId:number|string,albumId:number|string}} params - 查询参数。
 * @returns {Promise<object|null>} 相册详情或 null。
 */
async function getAlbumById({ userId, albumId }) {
  const album = albumModel.getAlbumById({ albumId, userId })
  if (!album) {
    return null
  }
  return _withAlbumCoverAndTimeRange(album)
}

/**
 * 内部方法：根据ID获取图片存储信息
 * @param {number|string} mediaId - 媒体 ID。
 * @returns {{thumbnailStorageKey?:string,highResStorageKey?:string}|null} 存储信息或 null。
 */
function _getMediaById(mediaId) {
  const image = mediaModel.getMediaStorageInfo(mediaId)
  return image
    ? {
        thumbnailStorageKey: image.thumbnailStorageKey,
        highResStorageKey: image.highResStorageKey
      }
    : null
}

module.exports = {
  getAlbumsList,
  getRecentAlbumsList,
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  addMediasToAlbum,
  removeMediasFromAlbum,
  setAlbumCover,
  restoreAlbumCover
}
