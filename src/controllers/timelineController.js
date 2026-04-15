/*
 * @Description: 时间轴（按年/月分组）接口控制器
 */
const mediaService = require('../services/mediaService')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')

/**
 * 获取时间轴相册列表
 * - 按年：GET /api/timeline?by=year&pageNo=1&pageSize=20（不包含 unknown）
 * - 按月：GET /api/timeline?by=month&pageNo=1&pageSize=20（不包含 unknown）
 * - 按日：GET /api/timeline?by=day&pageNo=1&pageSize=20（date_key，含 unknown 排在后）
 */
async function getTimelineAlbums(req, res, next) {
  try {
    const userId = req.user.userId
    const { by, pageNo = 1, pageSize = 20 } = req.query

    if (!by || !['year', 'month', 'day'].includes(by)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error',
        message: 'by 参数必需，且必须是 year、month 或 day'
      })
    }

    let queryResult
    if (by === 'year') {
      queryResult = await mediaService.getGroupsByYear({
        userId,
        pageNo: parseInt(pageNo, 10) || 1,
        pageSize: parseInt(pageSize, 10) || 20
      })
    } else if (by === 'month') {
      queryResult = await mediaService.getGroupsByMonth({
        userId,
        pageNo: parseInt(pageNo, 10) || 1,
        pageSize: parseInt(pageSize, 10) || 20
      })
    } else {
      queryResult = await mediaService.getGroupsByDate({
        userId,
        pageNo: parseInt(pageNo, 10) || 1,
        pageSize: parseInt(pageSize, 10) || 20
      })
    }

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } })
  } catch (error) {
    next(error)
  }
}

module.exports = {
  getTimelineAlbums
}
