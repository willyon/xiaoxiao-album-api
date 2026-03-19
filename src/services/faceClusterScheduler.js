/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类调度器 - 使用去抖机制自动触发聚类
 *
 * 📋 核心功能:
 * • 在人脸识别完成后，自动调度聚类任务
 * • 使用去抖机制，避免频繁执行聚类
 * • 支持最大延迟，确保定期执行聚类
 *
 * 🔄 工作流程:
 * 1. 人脸识别完成后调用 scheduleUserClustering(userId)
 * 2. 去抖机制：1分钟内多次调用只执行一次
 * 3. 最大延迟：可通过环境变量开启（默认关闭）
 * 4. 执行聚类：调用 faceClusterService.performFaceClustering
 */

const logger = require("../utils/logger");
const faceClusterService = require("./faceClusterService");

// 用户级去抖计时器
const userTimers = new Map();
// 用户级最大延迟计时器（确保即使有大量图片处理，也能定期执行聚类）
const userMaxDelayTimers = new Map();
// 记录首次调度时间
const userFirstScheduleTime = new Map();

// 去抖间隔（毫秒），默认 1 分钟，可通过环境变量覆盖
// 批量导入场景：更希望在“导入结束后”再聚类，因此默认放大去抖时间
const DEBOUNCE_MS = Number(process.env.FACE_CLUSTERING_DEBOUNCE_MS || 1 * 60 * 1000);
// 最大延迟时间（毫秒）。默认关闭（0），以确保只在导入停止后聚类；
// 如需在持续导入时也周期聚类，可设置为正数（例如 30*60*1000）。
const MAX_DELAY_MS = Number(process.env.FACE_CLUSTERING_MAX_DELAY_MS || 0);

/**
 * 调度用户的人脸聚类任务（去抖机制）
 * @param {number} userId - 用户ID
 */
function scheduleUserClustering(userId) {
  if (!userId) return;

  const now = Date.now();
  const firstScheduleTime = userFirstScheduleTime.get(userId);

  // 如果是首次调度，记录时间并设置最大延迟计时器
  if (!firstScheduleTime) {
    userFirstScheduleTime.set(userId, now);

    // 设置最大延迟计时器，确保即使有大量图片处理，也能定期执行聚类
    if (MAX_DELAY_MS > 0) {
      if (userMaxDelayTimers.has(userId)) {
        clearTimeout(userMaxDelayTimers.get(userId));
      }
      const maxDelayTimer = setTimeout(() => {
        userMaxDelayTimers.delete(userId);
        userFirstScheduleTime.delete(userId);
        // 清除去抖计时器，强制立即执行聚类
        if (userTimers.has(userId)) {
          clearTimeout(userTimers.get(userId));
          userTimers.delete(userId);
        }
        // 立即执行聚类
        _executeClustering(userId);
      }, MAX_DELAY_MS);
      userMaxDelayTimers.set(userId, maxDelayTimer);
    }
  }

  // 重置去抖计时器
  if (userTimers.has(userId)) {
    clearTimeout(userTimers.get(userId));
  }
  const timer = setTimeout(() => {
    userTimers.delete(userId);
    // 清除最大延迟计时器和首次调度时间
    if (userMaxDelayTimers.has(userId)) {
      clearTimeout(userMaxDelayTimers.get(userId));
      userMaxDelayTimers.delete(userId);
    }
    userFirstScheduleTime.delete(userId);
    _executeClustering(userId);
  }, DEBOUNCE_MS);
  userTimers.set(userId, timer);
}

/**
 * 执行人脸聚类（内部方法）
 * @param {number} userId - 用户ID
 */
async function _executeClustering(userId) {
  try {
    logger.info({
      message: `开始执行自动人脸聚类: userId=${userId}`,
    });

    const result = await faceClusterService.performFaceClustering({
      userId,
      recluster: true, // 重新聚类，删除旧数据
    });

    logger.info({
      message: `自动人脸聚类完成: userId=${userId}`,
      details: result,
    });
  } catch (error) {
    // 聚类失败不影响主流程，只记录警告
    logger.warn({
      message: `自动人脸聚类失败: userId=${userId}`,
      details: {
        error: error.message,
        stack: error.stack,
      },
    });
  }
}

module.exports = {
  scheduleUserClustering,
};
