const cleanupService = require("../services/cleanupService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");

function _extractUserId(req) {
  const userId = req?.user?.userId;
  if (!userId) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: "error",
    });
  }
  return userId;
}

async function handleGetSummary(req, res, next) {
  try {
    const userId = _extractUserId(req);
    const data = await cleanupService.getCleanupSummary(userId);
    res.sendResponse({ data });
  } catch (error) {
    next(error);
  }
}

async function handleGetGroups(req, res, next) {
  try {
    const userId = _extractUserId(req);
    const { type, pageNo, pageSize, cursor } = req.query;
    const pageParams = cursor
      ? _parseCursor(cursor)
      : {
          pageNo: Number(pageNo) || 1,
          pageSize: Number(pageSize) || 12,
        };

    const data = await cleanupService.getCleanupGroups({
      userId,
      type,
      pageNo: pageParams.pageNo,
      pageSize: pageParams.pageSize,
    });

    res.sendResponse({ data });
  } catch (error) {
    next(error);
  }
}

function _parseCursor(cursor) {
  if (!cursor || typeof cursor !== "string") {
    return { pageNo: 1, pageSize: 12 };
  }
  const [, pagePart] = cursor.split(":");
  const pageNo = Number(pagePart);
  if (!Number.isFinite(pageNo) || pageNo < 1) {
    return { pageNo: 1, pageSize: 12 };
  }
  return { pageNo, pageSize: 12 };
}

// 删除清理分组中的图片
async function handleDeleteImages(req, res, next) {
  try {
    const userId = _extractUserId(req);
    const { groupId, imageIds } = req.body || {};

    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    const result = await cleanupService.deleteImages({
      userId,
      groupId,
      imageIds,
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleGetSummary,
  handleGetGroups,
  handleDeleteImages,
};
