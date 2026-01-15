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

module.exports = {
  handleGetGroups,
};
