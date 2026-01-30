/*
 * @Description: 时间轴（按年/月分组）接口控制器
 */
const imageService = require("../services/imageService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");

/**
 * 获取时间轴相册列表
 * - 按年：GET /api/timeline?by=year&pageNo=1&pageSize=20（不包含 unknown）
 * - 按月：GET /api/timeline?by=month&pageNo=1&pageSize=20（不包含 unknown）
 * - 未知时间：GET /api/timeline?unknown=1（单独返回 unknown 相册）
 */
async function getTimelineAlbums(req, res, next) {
  try {
    const userId = req.user.userId;
    const { by, unknown, pageNo = 1, pageSize = 20 } = req.query;

    if (unknown === "1" || unknown === "true" || unknown === true) {
      const queryResult = await imageService.getUnknownGroup({ userId });
      res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
      return;
    }

    if (!by || !["year", "month"].includes(by)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
        message: "by 参数必需，且必须是 year 或 month；或传入 unknown=1 查询未知时间相册",
      });
    }

    let queryResult;
    if (by === "year") {
      queryResult = await imageService.getGroupsByYear({
        userId,
        pageNo: parseInt(pageNo, 10) || 1,
        pageSize: parseInt(pageSize, 10) || 20,
      });
    } else {
      queryResult = await imageService.getGroupsByMonth({
        userId,
        pageNo: parseInt(pageNo, 10) || 1,
        pageSize: parseInt(pageSize, 10) || 20,
      });
    }

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getTimelineAlbums,
};
