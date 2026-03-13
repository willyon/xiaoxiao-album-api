/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理控制器
 */
const {
  createSession,
  getActiveSession,
  getCurrentProgressSnapshot,
  getAiFailuresBySessionId,
  clearAiFailuresByMediaIds,
  resetAiErrorMarkersForRetry,
  decrementAiErrorCountForRetry,
} = require("../services/uploadSessionService");
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { searchIndexQueue } = require("../queues/searchIndexQueue");
const { getMediaDownloadInfo } = require("../services/mediaService");
const { publishProgressSnapshot } = require("../services/mediaProcessingProgressService");

/**
 * 处理创建上传会话请求
 */
const handleCreateSession = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const session = await createSession(userId);

    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: session,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 处理获取上传会话列表请求
 * GET /upload-sessions?active=true
 */
const handleGetActiveSession = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { active } = req.query;

    // 如果 active=true，只返回活跃会话；否则返回所有会话（未来扩展）
    if (active === "true") {
      const activeSession = await getActiveSession(userId);
      res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: activeSession,
      });
    } else {
      // TODO: 如果需要返回所有会话列表，需要实现新方法
      const activeSession = await getActiveSession(userId);
      res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: activeSession,
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * 获取当前会话快照
 * GET /upload-sessions/current-progress
 */
const handleGetCurrentProgress = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const snapshot = await getCurrentProgressSnapshot(userId);
    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: snapshot,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 获取会话失败明细
 * GET /upload-sessions/:sessionId/failures?stage=ai
 */
const handleGetSessionFailures = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const stage = req.query.stage || "ai";

    if (!sessionId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    if (stage !== "ai") {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const items = await getAiFailuresBySessionId(sessionId);
    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: {
        sessionId,
        stage,
        total: items.length,
        items,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 重试会话失败项（AI）
 * POST /upload-sessions/:sessionId/retry-failures?stage=ai
 * body: { mediaIds?: number[] }
 */
const handleRetrySessionFailures = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { sessionId } = req.params;
    const stage = req.query.stage || req.body?.stage || "ai";
    const bodyMediaIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : null;

    if (!sessionId || stage !== "ai") {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const allFailures = await getAiFailuresBySessionId(sessionId);
    if (!allFailures || allFailures.length === 0) {
      return res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: {
          sessionId,
          stage: "ai",
          retriedCount: 0,
          skippedCount: 0,
          mediaIds: [],
        },
      });
    }

    const retryableFailures = allFailures.filter((item) => item.retryable !== false);
    const targetSet = bodyMediaIds ? new Set(bodyMediaIds.map((id) => String(id))) : null;
    const targetFailures = retryableFailures.filter((item) => {
      if (!item.mediaId) return false;
      return targetSet ? targetSet.has(String(item.mediaId)) : true;
    });

    if (targetFailures.length === 0) {
      return res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: {
          sessionId,
          stage: "ai",
          retriedCount: 0,
          skippedCount: allFailures.length,
          mediaIds: [],
        },
      });
    }

    let retriedCount = 0;
    const retriedMediaIds = [];

    for (const failure of targetFailures) {
      const mediaId = Number(failure.mediaId);
      if (!mediaId) continue;

      const mediaInfo = await getMediaDownloadInfo({ userId, imageId: mediaId });
      if (!mediaInfo) {
        continue;
      }

      await searchIndexQueue.add(
        process.env.SEARCH_INDEX_QUEUE_NAME,
        {
          imageId: mediaInfo.id,
          userId,
          highResStorageKey: mediaInfo.highResStorageKey || null,
          originalStorageKey: mediaInfo.originalStorageKey || null,
          sessionId,
          mediaType: mediaInfo.mediaType || "image",
          fileName: failure.fileName || "",
        },
        {
          jobId: `retry:${userId}:${mediaInfo.id}:${Date.now()}`,
        },
      );

      retriedMediaIds.push(String(mediaInfo.id));
      retriedCount += 1;
    }

    if (retriedMediaIds.length > 0) {
      await clearAiFailuresByMediaIds(sessionId, retriedMediaIds);
      await resetAiErrorMarkersForRetry(sessionId, retriedMediaIds);
      await decrementAiErrorCountForRetry(sessionId, retriedMediaIds.length);
      await publishProgressSnapshot(sessionId);
    }

    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: {
        sessionId,
        stage: "ai",
        retriedCount,
        skippedCount: allFailures.length - retriedCount,
        mediaIds: retriedMediaIds,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleCreateSession,
  handleGetActiveSession,
  handleGetCurrentProgress,
  handleGetSessionFailures,
  handleRetrySessionFailures,
};
