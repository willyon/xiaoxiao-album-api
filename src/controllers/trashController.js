/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 回收站控制器 - 处理回收站相关的HTTP请求
 */

const trashService = require('../services/trashService')
const asyncHandler = require('../utils/asyncHandler')
const { requireUserId, requireNonEmptyMediaIds, parseBoundedPagination } = require('../utils/requestParams')

/**
 * 分页获取已删除媒体列表
 * GET /api/trash?pageNo=1&pageSize=20
 */
async function handleGetDeletedMedias(req, res) {
  const userId = requireUserId(req)
  const { pageNo, pageSize } = parseBoundedPagination(req.query, { pageNo: 1, pageSize: 20 }, { maxPageSize: 100 })
  const mediaType = req.query.mediaType || 'all'

  const result = await trashService.getDeletedMedias({
    userId,
    pageNo,
    pageSize,
    mediaType
  })

  res.sendResponse({
    data: {
      list: result.list,
      total: result.total
    }
  })
}

/**
 * 恢复媒体
 * POST /images/trash/restore
 * Body: { mediaIds: number[] }
 */
async function handleRestoreMedias(req, res) {
  const userId = requireUserId(req)
  const mediaIds = requireNonEmptyMediaIds(req.body, { messageType: 'warning' })

  const result = await trashService.restoreMedias({ userId, mediaIds })
  res.sendResponse({
    data: result,
    messageCode: 'trash.restore.success'
  })
}

/**
 * 彻底删除媒体
 * POST /images/trash/permanently-delete
 * Body: { mediaIds: number[] }
 */
async function handlePermanentlyDeleteMedias(req, res) {
  const userId = requireUserId(req)
  const mediaIds = requireNonEmptyMediaIds(req.body, { messageType: 'warning' })

  const result = await trashService.permanentlyDeleteMedias({ userId, mediaIds })
  res.sendResponse({
    data: result,
    messageCode: 'trash.permanentlyDelete.success'
  })
}

/**
 * 清空回收站
 * POST /images/trash/clear
 */
async function handleClearTrash(req, res) {
  const userId = requireUserId(req)

  const result = await trashService.clearTrash({ userId })
  res.sendResponse({
    data: result,
    messageCode: 'trash.clear.success'
  })
}

module.exports = {
  handleGetDeletedMedias: asyncHandler(handleGetDeletedMedias),
  handleRestoreMedias: asyncHandler(handleRestoreMedias),
  handlePermanentlyDeleteMedias: asyncHandler(handlePermanentlyDeleteMedias),
  handleClearTrash: asyncHandler(handleClearTrash)
}
