/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 图片处理进度推送控制器（Server-Sent Events）
 */
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const { getRedisClient } = require("../services/redisClient");
const { setupProgressStream } = require("../services/imageProcessingProgressService");
const logger = require("../utils/logger");

// 获取Redis客户端实例
const redisClient = getRedisClient();

/**
 * 图片处理进度推送流（SSE）
 * GET /api/progress/stream?sessionId=xxx
 */
const progressStream = async (req, res, next) => {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
        details: "sessionId is required",
      });
    }

    // 验证会话是否存在（通过Redis检查）
    const redisData = await redisClient.hgetall(`upload:session:${sessionId}`);
    if (!redisData || Object.keys(redisData).length === 0) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.UPLOAD_SESSION_NOT_FOUND,
        messageType: "error",
      });
    }

    // 通过sessionId验证会话存在性
    // 注意：这里不进行严格的用户身份验证，因为EventSource无法发送认证头
    // 会话ID是UUID，具有足够的随机性，可以防止恶意访问

    // 设置SSE响应头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 设置Redis实时推送
    await setupProgressStream(req, res, sessionId);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  progressStream,
};
