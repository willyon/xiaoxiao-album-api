/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册API控制器
 */
const albumService = require('../services/albumService')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const asyncHandler = require('../utils/asyncHandler')
const {
  parsePositiveIntParam,
  requireNonEmptyIdArray,
  parsePagination
} = require('../utils/requestParams')

/**
 * 创建相册
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function createAlbum(req, res) {
  const userId = req.user.userId
  const { name, description } = req.body

  const album = await albumService.createAlbum({
    userId,
    name,
    description
  })

  res.sendResponse({ data: album })
}

/**
 * 获取相册详情
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function getAlbumById(req, res) {
  const userId = req.user.userId
  const albumId = parsePositiveIntParam(req.params.albumId)

  const album = await albumService.getAlbumById({
    albumId,
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
}

/**
 * 更新相册
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function updateAlbum(req, res) {
  const userId = req.user.userId
  const albumId = parsePositiveIntParam(req.params.albumId)
  const { name, description, coverImageId } = req.body

  const album = await albumService.updateAlbum({
    userId,
    albumId,
    name,
    description,
    coverImageId: coverImageId ? parsePositiveIntParam(coverImageId) : undefined
  })

  res.sendResponse({ data: album })
}

/**
 * 删除相册
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function deleteAlbum(req, res) {
  const userId = req.user.userId
  const albumId = parsePositiveIntParam(req.params.albumId)

  await albumService.deleteAlbum({
    userId,
    albumId
  })

  res.sendResponse({ data: { success: true } })
}

/**
 * 获取自定义相册列表
 * GET /api/albums?pageNo=1&pageSize=20&search=xxx&excludeAlbumId=123
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function getCustomAlbums(req, res) {
  const userId = req.user.userId
  const { search, excludeAlbumId } = req.query
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 20 })
  const excludeId = excludeAlbumId ? parsePositiveIntParam(excludeAlbumId) : null

  const result = await albumService.getAlbumsList({
    userId,
    pageNo,
    pageSize,
    search: search || null,
    excludeAlbumId: excludeId
  })

  res.sendResponse({ data: result })
}

/**
 * 获取最近使用的相册（前 limit 个，用于「添加到相册」递进式弹窗第一屏）
 * GET /api/albums/recent?limit=8&excludeAlbumId=123
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function getRecentAlbums(req, res) {
  const userId = req.user.userId
  const limitRaw = req.query.limit
  const limit = Math.min(limitRaw ? parsePositiveIntParam(limitRaw) : 8, 20)
  const excludeAlbumId = req.query.excludeAlbumId ? parsePositiveIntParam(req.query.excludeAlbumId) : null

  const result = await albumService.getRecentAlbumsList({
    userId,
    limit,
    excludeAlbumId
  })
  res.sendResponse({ data: result })
}

/**
 * 添加图片到相册（albumId 为数字相册 ID）
 * Body: { mediaIds: number[] }
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function addMediasToAlbum(req, res) {
  await handleAlbumMediaMutation(req, res, albumService.addMediasToAlbum)
}

/**
 * 从相册中移除图片（albumId 为数字相册 ID）
 * Body: { mediaIds: number[] }
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function removeMediasFromAlbum(req, res) {
  await handleAlbumMediaMutation(req, res, albumService.removeMediasFromAlbum)
}

async function handleAlbumMediaMutation(req, res, action) {
  const userId = req.user.userId
  const { albumId } = req.params
  const { mediaIds } = req.body

  const albumIdNum = parsePositiveIntParam(albumId)
  const ids = requireNonEmptyIdArray(mediaIds)

  const result = await action({
    userId,
    albumId: albumIdNum,
    mediaIds: ids
  })

  res.sendResponse({ data: result })
}

/**
 * 设置相册封面图片
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function setAlbumCover(req, res) {
  const userId = req.user.userId
  const { albumId } = req.params
  const { mediaId } = req.body
  const mediaIdNum = parsePositiveIntParam(mediaId)

  const result = await albumService.setAlbumCover({
    userId,
    albumId: parsePositiveIntParam(albumId),
    mediaId: mediaIdNum
  })

  res.sendResponse({ data: result })
}

/**
 * 恢复相册默认封面（最近加入的一张图/视频，与系统自动封面规则一致）
 * DELETE /api/albums/:albumId/cover
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function restoreAlbumCover(req, res) {
  const userId = req.user.userId
  const { albumId } = req.params
  const albumIdNum = parsePositiveIntParam(albumId)

  const result = await albumService.restoreAlbumCover({
    userId,
    albumId: albumIdNum
  })

  res.sendResponse({ data: result })
}

module.exports = {
  createAlbum: asyncHandler(createAlbum),
  getAlbumById: asyncHandler(getAlbumById),
  updateAlbum: asyncHandler(updateAlbum),
  deleteAlbum: asyncHandler(deleteAlbum),
  getCustomAlbums: asyncHandler(getCustomAlbums),
  getRecentAlbums: asyncHandler(getRecentAlbums),
  addMediasToAlbum: asyncHandler(addMediasToAlbum),
  removeMediasFromAlbum: asyncHandler(removeMediasFromAlbum),
  setAlbumCover: asyncHandler(setAlbumCover),
  restoreAlbumCover: asyncHandler(restoreAlbumCover)
}
