/*
 * @Description: 地点相册列表（地点键：优先 city，否则 country）
 */
const mediaService = require('../services/mediaService')
const asyncHandler = require('../utils/asyncHandler')
const { parsePagination } = require('../utils/requestParams')

/**
 * 获取地点相册列表（按地点键分组）
 * GET /api/locations?pageNo=1&pageSize=20
 */
async function getLocations(req, res) {
  const userId = req.user.userId
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 20 })

  const queryResult = await mediaService.getGroupsByCity({
    userId,
    pageNo,
    pageSize
  })

  res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } })
}

module.exports = {
  getLocations: asyncHandler(getLocations)
}
