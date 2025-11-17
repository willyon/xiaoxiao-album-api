const logger = require("../utils/logger");
const cleanupGroupingService = require("./cleanupGroupingService");

// 用户级去抖计时器
const userTimers = new Map();

// 去抖间隔（毫秒），默认 60s，可通过环境变量覆盖
const DEBOUNCE_MS = Number(process.env.CLEANUP_GROUPING_DEBOUNCE_MS || 60000);

function scheduleUserRebuild(userId) {
  if (!userId) return;
  if (userTimers.has(userId)) {
    clearTimeout(userTimers.get(userId));
  }
  const timer = setTimeout(() => {
    userTimers.delete(userId);
    try {
      const summary = cleanupGroupingService.rebuildCleanupGroups({ userId });
      logger.info({ message: "分组去抖重建完成", details: { userId, summary } });
    } catch (e) {
      logger.warn({ message: "分组去抖重建失败", details: { userId, error: e.message } });
    }
  }, DEBOUNCE_MS);
  userTimers.set(userId, timer);
}

module.exports = {
  scheduleUserRebuild,
};
