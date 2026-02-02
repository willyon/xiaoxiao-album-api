/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 回收站控制器 - 处理回收站相关的HTTP请求
 */

const trashService = require("../services/trashService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const logger = require("../utils/logger");

/**
 * 分页获取已删除图片列表
 * GET /api/trash?pageNo=1&pageSize=20
 */
async function handleGetDeletedImages(req, res, next) {
  try {
    const { userId } = req?.user;
    if (!userId) {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
      });
    }

    const pageNo = Number(req.query.pageNo) || 1;
    const pageSize = Number(req.query.pageSize) || 20;

    if (pageNo < 1 || pageSize < 1 || pageSize > 100) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    const result = await trashService.getDeletedImages({
      userId,
      pageNo,
      pageSize,
    });

    res.sendResponse({
      data: {
        list: result.list,
        total: result.total,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 恢复图片
 * POST /images/trash/restore
 * Body: { imageIds: [1, 2, 3] }
 */
async function handleRestoreImages(req, res, next) {
  try {
    const { userId } = req?.user;
    if (!userId) {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
      });
    }

    const { imageIds } = req.body;
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    const result = await trashService.restoreImages({ userId, imageIds });
    res.sendResponse({
      data: result,
      messageCode: "trash.restore.success",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 彻底删除图片
 * POST /images/trash/permanently-delete
 * Body: { imageIds: [1, 2, 3] }
 */
async function handlePermanentlyDeleteImages(req, res, next) {
  try {
    const { userId } = req?.user;
    if (!userId) {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
      });
    }

    const { imageIds } = req.body;
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    const result = await trashService.permanentlyDeleteImages({ userId, imageIds });
    res.sendResponse({
      data: result,
      messageCode: "trash.permanentlyDelete.success",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 清空回收站
 * POST /images/trash/clear
 */
async function handleClearTrash(req, res, next) {
  try {
    const { userId } = req?.user;
    if (!userId) {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
      });
    }

    const result = await trashService.clearTrash({ userId });
    res.sendResponse({
      data: result,
      messageCode: "trash.clear.success",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleGetDeletedImages,
  handleRestoreImages,
  handlePermanentlyDeleteImages,
  handleClearTrash,
};
