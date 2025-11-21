const logger = require("../utils/logger");
const cleanupGroupingService = require("./cleanupGroupingService");

// 用户级去抖计时器
const userTimers = new Map();
// 用户级最大延迟计时器（确保即使有大量图片处理，也能定期重建）
const userMaxDelayTimers = new Map();
// 记录首次调度时间
const userFirstScheduleTime = new Map();

// 去抖间隔（毫秒），默认 60s，可通过环境变量覆盖
const DEBOUNCE_MS = Number(process.env.CLEANUP_GROUPING_DEBOUNCE_MS || 60000);
// 最大延迟时间（毫秒），默认 5 分钟，确保即使有大量图片处理，也能定期重建
const MAX_DELAY_MS = Number(process.env.CLEANUP_GROUPING_MAX_DELAY_MS || 300000);

function scheduleUserRebuild(userId) {
  if (!userId) return;

  const now = Date.now();
  const firstScheduleTime = userFirstScheduleTime.get(userId);

  // 如果是首次调度，记录时间并设置最大延迟计时器
  if (!firstScheduleTime) {
    userFirstScheduleTime.set(userId, now);

    // 设置最大延迟计时器，确保即使有大量图片处理，也能定期重建
    if (userMaxDelayTimers.has(userId)) {
      clearTimeout(userMaxDelayTimers.get(userId));
    }
    const maxDelayTimer = setTimeout(() => {
      userMaxDelayTimers.delete(userId);
      userFirstScheduleTime.delete(userId);
      // 清除去抖计时器，强制立即重建
      if (userTimers.has(userId)) {
        clearTimeout(userTimers.get(userId));
        userTimers.delete(userId);
      }
      // 立即执行重建
      _executeRebuild(userId);
    }, MAX_DELAY_MS);
    userMaxDelayTimers.set(userId, maxDelayTimer);
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
    _executeRebuild(userId);
  }, DEBOUNCE_MS);
  userTimers.set(userId, timer);
}

function _executeRebuild(userId) {
    try {
      const summary = cleanupGroupingService.rebuildCleanupGroups({ userId });
      logger.info({ message: "分组去抖重建完成", details: { userId, summary } });
    } catch (e) {
      logger.warn({ message: "分组去抖重建失败", details: { userId, error: e.message } });
    }
}

module.exports = {
  scheduleUserRebuild,
};
