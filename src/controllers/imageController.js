/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:45:00
 * @Description: File description
 */
const imageService = require("../services/imageService");
const similarService = require("../services/similarService");
const CustomError = require("../errors/customError");
const { ERROR_CODES, SUCCESS_CODES } = require("../constants/messageCodes");
const { getRedisClient } = require("../services/redisClient");
const { ensureUserSetReady, userSetKey } = require("../workers/userImageHashset");
const { updateProgress } = require("../services/imageProcessingProgressService");
const logger = require("../utils/logger");

// 分页获取模糊图列表（is_blurry = 1），用于清理页模糊图 tab
// GET /api/images/blurry?pageNo=1&pageSize=20
async function handleGetBlurryImages(req, res, next) {
  try {
    const { userId } = req?.user;
    const { pageNo, pageSize } = req.query;
    const result = await imageService.getBlurryImages({
      userId,
      pageNo,
      pageSize,
    });
    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

// 分页获取相似图分组列表（清理页相似图 tab）
// GET /api/images/similar?pageNo=1&pageSize=12
async function handleGetSimilarGroups(req, res, next) {
  try {
    const { userId } = req?.user;
    const { pageNo, pageSize } = req.query;
    const data = await similarService.getSimilarGroups({
      userId,
      pageNo: Number(pageNo) || 1,
      pageSize: Number(pageSize) || 12,
    });
    res.sendResponse({ data });
  } catch (error) {
    next(error);
  }
}

/**
 * 预检文件是否存在 - 通用图片检查接口
 * POST /images/checkFileExists
 * Body: { hash }
 *
 * 作用：检查指定哈希的图片是否已存在，用于前端预检和秒传功能
 */
async function handleCheckFileExists(req, res, next) {
  try {
    const { hash, sessionId } = req.body;
    const userId = req?.user?.userId;

    if (!hash) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
      });
    }

    // 确保用户的 Redis hash 集合已初始化
    await ensureUserSetReady(userId);

    // 使用 Redis 检查文件是否已存在
    const redisClient = getRedisClient();
    const setKey = userSetKey(userId);
    const exists = await redisClient.sismember(setKey, hash);

    if (exists === 1) {
      // 文件已存在
      logger.info({
        message: "File exists check: found existing file",
        details: { userId, imageHash: hash },
      });

      // 如果有sessionId，更新已存在文件计数
      if (sessionId) {
        await updateProgress({
          sessionId,
          status: "existingFiles",
        });
      }

      return res.sendResponse({
        data: { exists: true },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    } else {
      // 文件不存在
      return res.sendResponse({
        data: { exists: false },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    }
  } catch (error) {
    next(error);
  }
}

// 部分更新图片信息（仅用于 favorite 字段）
async function handlePatchImage(req, res, next) {
  try {
    const { userId } = req?.user;
    const { imageId } = req.params;
    const patchData = req.body; // { favorite: true }

    if (!imageId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
      });
    }

    const result = await imageService.patchImage({ userId, imageId: parseInt(imageId), patchData });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

// 批量删除图片（软删除，移至回收站）
async function handleDeleteImages(req, res, next) {
  try {
    const { userId } = req?.user;
    const { imageIds, groupId } = req.body || {};

    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    // 相似图删除：提供 groupId 时走 similarService（需刷新分组统计）；其余（含模糊图、首页等）走 imageService 通用删除
    let result;
    if (groupId) {
      result = await similarService.deleteImages({
        userId,
        groupId,
        imageIds,
      });
    } else {
      result = await imageService.deleteImages({
        userId,
        imageIds,
      });
    }

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleGetBlurryImages,
  handleGetSimilarGroups,
  handleCheckFileExists,
  handlePatchImage,
  handleDeleteImages,
};
