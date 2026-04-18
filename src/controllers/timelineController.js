/*
 * @Description: 时间轴（按年/月分组）接口控制器
 */
const mediaService = require('../services/mediaService')
const asyncHandler = require('../utils/asyncHandler')
const { parsePagination, throwInvalidParametersError } = require('../utils/requestParams')

/**
 * 获取时间轴相册列表
 * - 按年：GET /api/timeline?by=year&pageNo=1&pageSize=20（不包含 unknown）
 * - 按月：GET /api/timeline?by=month&pageNo=1&pageSize=20（不包含 unknown）
 * - 按日：GET /api/timeline?by=day&pageNo=1&pageSize=20（date_key，含 unknown 排在后）
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function getTimelineAlbums(req, res) {
  const userId = req.user.userId
  const { by } = req.query
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 20 })

  if (!by || !['year', 'month', 'day'].includes(by)) {
    throwInvalidParametersError({
      messageType: 'error',
      message: 'by 参数必需，且必须是 year、month 或 day'
    })
  }

  let queryResult
  if (by === 'year') {
    queryResult = await mediaService.getGroupsByYear({
      userId,
      pageNo,
      pageSize
    })
  } else if (by === 'month') {
    queryResult = await mediaService.getGroupsByMonth({
      userId,
      pageNo,
      pageSize
    })
  } else {
    queryResult = await mediaService.getGroupsByDate({
      userId,
      pageNo,
      pageSize
    })
  }

  res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } })
}

module.exports = {
  getTimelineAlbums: asyncHandler(getTimelineAlbums)
}
