/*
 * @Description: 地点相册列表（地点键：优先 city，否则 country）
 */
const mediaService = require('../services/mediaService')

/**
 * 获取地点相册列表（按地点键分组）
 * GET /api/locations?pageNo=1&pageSize=20
 */
async function getLocations(req, res, next) {
  try {
    const userId = req.user.userId
    const { pageNo = 1, pageSize = 20 } = req.query

    const queryResult = await mediaService.getGroupsByCity({
      userId,
      pageNo: parseInt(pageNo, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20
    })

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } })
  } catch (error) {
    next(error)
  }
}

module.exports = {
  getLocations
}
