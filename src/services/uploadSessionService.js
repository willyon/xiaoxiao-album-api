/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理服务
 */
const { v4: uuidv4 } = require("uuid");
const { getRedisClient } = require("./redisClient");
const logger = require("../utils/logger");

// 获取 Redis 客户端实例
const redisClient = getRedisClient();

/**
 * 创建上传会话
 * @param {string} userId - 用户ID
 * @returns {Object} 会话对象
 */
async function createSession(userId) {
  // 生成会话ID
  const sessionId = uuidv4();

  // 在Redis中创建会话
  await redisClient.hset(`upload:session:${sessionId}`, {
    uploadedCount: 0,
    thumbDone: 0,
    highResDone: 0,
    processingErrors: 0,
    duplicateCount: 0,
    existingFiles: 0,
  });

  // 设置用户的最新会话ID（覆盖之前的会话）
  await redisClient.set(`user:latest:session:${userId}`, sessionId);

  // 设置过期时间（1天）
  await redisClient.expire(`upload:session:${sessionId}`, 1 * 24 * 3600);
  await redisClient.expire(`user:latest:session:${userId}`, 1 * 24 * 3600);

  return {
    sessionId,
    uploadedCount: 0,
    thumbDone: 0,
    highResDone: 0,
    processingErrors: 0,
    duplicateCount: 0,
    existingFiles: 0,
  };
}

/**
 * 获取用户的活跃会话
 * @param {string} userId - 用户ID
 * @returns {Object|null} 会话对象，如果没有活跃会话则返回null
 */
async function getActiveSession(userId) {
  // 获取用户的最新会话ID
  const activeSessionId = await redisClient.get(`user:latest:session:${userId}`);

  if (!activeSessionId) {
    return null;
  }

  try {
    // 直接获取最新会话的详细信息
    const redisData = await redisClient.hgetall(`upload:session:${activeSessionId}`);

    if (redisData && Object.keys(redisData).length > 0) {
      // 基于数据驱动判断会话是否完成
      const uploadedCount = parseInt(redisData.uploadedCount) || 0;
      const highResDone = parseInt(redisData.highResDone) || 0;
      const thumbDone = parseInt(redisData.thumbDone) || 0;
      const processingErrors = parseInt(redisData.processingErrors) || 0;
      const duplicateCount = parseInt(redisData.duplicateCount) || 0;
      const existingFiles = parseInt(redisData.existingFiles) || 0;

      // 活跃状态判断逻辑：
      // 1. 如果有实际上传文件且未处理完成，活跃
      // 2. 如果只有重复/已存在文件，不活跃（立即完成）
      const isActive = uploadedCount > 0 && highResDone + processingErrors < uploadedCount;

      if (!isActive) {
        return null;
      }

      return {
        sessionId: activeSessionId,
        uploadedCount,
        thumbDone,
        highResDone,
        processingErrors,
        duplicateCount,
        existingFiles,
      };
    }

    return null;
  } catch (redisError) {
    logger.warn({
      message: "Redis数据获取失败",
      details: { sessionId: activeSessionId, error: redisError.message },
    });
    return null;
  }
}

module.exports = {
  createSession,
  getActiveSession,
};
