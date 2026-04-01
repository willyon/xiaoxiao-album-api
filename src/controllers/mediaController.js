/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:45:00
 * @Description: File description
 */
const mediaService = require("../services/mediaService");
const similarService = require("../services/similarService");
const CustomError = require("../errors/customError");
const { ERROR_CODES, SUCCESS_CODES } = require("../constants/messageCodes");
const { getRedisClient } = require("../services/redisClient");
const { userSetKey } = require("../workers/userMediaHashset");
const { updateProgress } = require("../services/mediaProcessingProgressService");
const logger = require("../utils/logger");
const { getMediaDownloadInfo, rebuildMediaSearchDoc, selectMediaRowByHashForUser } = require("../models/mediaModel");
const trashService = require("../services/trashService");
const { mediaAnalysisQueue } = require("../queues/mediaAnalysisQueue");

// 分页获取模糊图列表（is_blurry = 1），用于清理页模糊图 tab
// GET /api/media/blurry?pageNo=1&pageSize=20
async function handleGetBlurryMedias(req, res, next) {
  try {
    const { userId } = req?.user;
    const { pageNo, pageSize } = req.query;
    const result = await mediaService.getBlurryMedias({
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
// GET /api/media/similar?pageNo=1&pageSize=12
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
 * 以库内 (user_id, file_hash) 为准：
 * - 无行：清理 Redis 陈旧 hash，返回不存在
 * - 仅回收站有行：静默恢复后返回 exists:true（计 uploadedCount，不计「跳过」）
 * - 正常库内：秒传，计 existingFiles
 */
async function handleCheckFileExists(req, res, next) {
  try {
    const { hash, sessionId } = req.body;
    const userId = req?.user?.userId;

    if (!hash) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const redisClient = getRedisClient();
    const setKey = userSetKey(userId);
    const row = selectMediaRowByHashForUser({ userId, imageHash: hash });

    if (!row) {
      try {
        await redisClient.srem(setKey, hash);
      } catch {
        /* ignore */
      }
      return res.sendResponse({
        data: { exists: false },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    }

    if (row.deleted_at != null) {
      await trashService.restoreMedias({ userId, imageIds: [row.id] });
      try {
        await redisClient.sadd(setKey, hash);
      } catch {
        /* ignore */
      }
      if (sessionId) {
        // 与正常入库后走 meta 流水线一致：基础处理进度 = ingestDoneCount/uploadedCount
        await updateProgress({ sessionId, status: "uploadedCount" });
        await updateProgress({ sessionId, status: "ingestDoneCount" });
      }
      logger.info({
        message: "checkFileExists: restored from trash on re-upload",
        details: { userId, imageHash: hash, mediaId: row.id },
      });
      return res.sendResponse({
        data: { exists: true, restoredFromTrash: true },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    }

    logger.info({
      message: "File exists check: found active media",
      details: { userId, imageHash: hash },
    });

    if (sessionId) {
      await updateProgress({
        sessionId,
        status: "existingFiles",
      });
    }
    try {
      await redisClient.sadd(setKey, hash);
    } catch {
      /* ignore */
    }

    return res.sendResponse({
      data: { exists: true },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

// 部分更新图片信息（仅用于 favorite 字段）
async function handlePatchMedia(req, res, next) {
  try {
    const { userId } = req?.user;
    const { mediaId } = req.params;
    const patchData = req.body; // { favorite: true }

    if (!mediaId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const result = await mediaService.patchMedia({ userId, imageId: parseInt(mediaId), patchData });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

// 批量删除图片（软删除，移至回收站）
async function handleDeleteMedias(req, res, next) {
  try {
    const { userId } = req?.user;
    const { mediaIds, groupId } = req.body || {};

    if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    // 相似图删除：提供 groupId 时走 similarService（需刷新分组统计）；其余（含模糊图、首页等）走 imageService 通用删除
    let result;
    if (groupId) {
      result = await similarService.deleteMedias({
        userId,
        groupId,
        imageIds: mediaIds,
      });
    } else {
      result = await mediaService.deleteMedias({
        userId,
        imageIds: mediaIds,
      });
    }

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 单图重新分析：将指定媒体重新入队 mediaAnalysisQueue（手动强制重算，使用新 jobId 绕过去重）
 * POST /api/media/:mediaId/reanalyze
 */
async function handleReanalyzeMedia(req, res, next) {
  try {
    const userId = req?.user?.userId;
    const mediaId = parseInt(req.params.mediaId, 10);

    if (!mediaId || Number.isNaN(mediaId)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const media = getMediaDownloadInfo({ userId, imageId: mediaId });
    if (!media) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "warning",
      });
    }

    const jobId = `analysis:${userId}:${mediaId}:manual:${Date.now()}`;
    await mediaAnalysisQueue.add(
      "media-analysis",
      {
        imageId: mediaId,
        userId,
        highResStorageKey: media.highResStorageKey ?? null,
        originalStorageKey: media.originalStorageKey ?? null,
        mediaType: media.mediaType || "image",
        fileName: "",
        forceReanalyze: true,
      },
      { jobId },
    );

    logger.info({
      message: "media reanalyze enqueued",
      details: { userId, mediaId, jobId },
    });

    res.sendResponse({
      data: { mediaId, jobId, enqueued: true },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 指定 mediaId 重建搜索文档：仅刷新 media_search，不重新跑 AI 分析
 * POST /api/media/:mediaId/rebuild-search
 */
async function handleRebuildSearchMedia(req, res, next) {
  try {
    const userId = req?.user?.userId;
    const mediaId = parseInt(req.params.mediaId, 10);

    if (!mediaId || Number.isNaN(mediaId)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const media = getMediaDownloadInfo({ userId, imageId: mediaId });
    if (!media) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "warning",
      });
    }

    rebuildMediaSearchDoc(mediaId);

    logger.info({
      message: "media search doc rebuilt",
      details: { userId, mediaId },
    });

    res.sendResponse({
      data: { mediaId, rebuilt: true },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleGetBlurryMedias,
  handleGetSimilarGroups,
  handleCheckFileExists,
  handlePatchMedia,
  handleDeleteMedias,
  handleReanalyzeMedia,
  handleRebuildSearchMedia,
};
