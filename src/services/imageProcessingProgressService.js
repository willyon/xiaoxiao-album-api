/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 图片处理进度管理服务
 */
const { getRedisClient } = require("./redisClient");
const logger = require("../utils/logger");

// 获取 Redis 客户端单实例
const redisClient = getRedisClient();

/**
 * 更新图片处理进度
 * @param {Object} params - 参数对象
 * @param {string} params.sessionId - 会话ID
 * @param {string} params.imageHash - 图片哈希
 * @param {string} params.status - 处理状态：'thumbDone'、'highResDone' 或 'processingErrors'
 */
async function updateProgress({ sessionId, imageHash, status }) {
  if (!sessionId) return;

  try {
    // 更新Redis计数：增加指定状态字段的计数值（+1）
    await redisClient.hincrby(`upload:session:${sessionId}`, status, 1);

    // 注意：不再需要检查会话完成状态，前端基于数据自动判断

    // 发布进度更新事件
    await _publishProgressUpdate(sessionId);
  } catch (error) {
    logger.error({
      message: "更新处理进度失败",
      details: { sessionId, imageHash, status, error: error.message },
    });
  }
}

/**
 * 发布图片处理进度更新事件
 * @param {string} sessionId - 会话ID
 */
async function _publishProgressUpdate(sessionId) {
  try {
    // 获取最新的会话数据
    const redisData = await redisClient.hgetall(`upload:session:${sessionId}`);

    if (redisData && Object.keys(redisData).length > 0) {
      // 构建进度数据
      const progressData = {
        sessionId,
        totalCount: parseInt(redisData.totalCount) || 0,
        uploadedCount: parseInt(redisData.uploadedCount) || 0,
        thumbDone: parseInt(redisData.thumbDone) || 0,
        highResDone: parseInt(redisData.highResDone) || 0,
        processingErrors: parseInt(redisData.processingErrors) || 0,
      };

      // 发布到Redis频道
      await redisClient.publish(`session:${sessionId}:progress`, JSON.stringify(progressData));
    }
  } catch (error) {
    logger.error({
      message: "发布进度更新失败",
      details: { sessionId, error: error.message },
    });
  }
}

/**
 * 设置Redis图片处理进度实时推送
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @param {string} sessionId - 会话ID
 */
async function setupProgressStream(req, res, sessionId) {
  try {
    // 创建一个新的、独立的Redis连接（因为同一个redis连接不能同时用于命令执行和订阅）
    const subscriber = redisClient.duplicate();
    await subscriber.subscribe(`session:${sessionId}:progress`);

    // 监听Redis消息
    subscriber.on("message", (channel, message) => {
      try {
        // 直接转发Redis消息给前端
        res.write(`data: ${message}\n\n`);

        // 检查是否已完成（基于数据驱动判断）
        const progressData = JSON.parse(message);
        const { uploadedCount, highResDone, processingErrors } = progressData;
        const isCompleted = highResDone + processingErrors >= uploadedCount && uploadedCount > 0;

        if (isCompleted) {
          subscriber.unsubscribe();
          subscriber.disconnect();
          res.end();
        }
      } catch (error) {
        logger.error({
          message: "处理Redis消息失败",
          details: { sessionId, channel, error: error.message },
        });
      }
    });

    // 监听连接关闭，清理Redis订阅
    req.on("close", () => {
      subscriber.unsubscribe();
      subscriber.disconnect();
    });
  } catch (error) {
    logger.error({
      message: "设置Redis进度推送失败",
      details: { sessionId, error: error.message },
    });
  }
}

module.exports = {
  updateProgress,
  setupProgressStream,
};
