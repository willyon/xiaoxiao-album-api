const logger = require('../utils/logger')
const { createDebouncedUserScheduler } = require('../utils/debouncedUserScheduler')
const cleanupGroupingService = require('./cleanupGroupingService')

// 去抖间隔（毫秒），默认 1 分钟；批量导入场景更希望在「导入结束后」再重建
const DEBOUNCE_MS = Number(process.env.CLEANUP_GROUPING_DEBOUNCE_MS || 1 * 60 * 1000)

const { schedule: scheduleUserRebuild } = createDebouncedUserScheduler({
  debounceMs: DEBOUNCE_MS,
  execute(userId) {
    try {
      const summary = cleanupGroupingService.rebuildCleanupGroups({ userId })
      logger.info({ message: '分组去抖重建完成', details: { userId, summary } })
    } catch (e) {
      const hint = /no such table:.*\.images/i.test(e.message)
        ? ' 当前代码使用 media 表；若报 main.images 请确认数据库已迁移或已用 initTableModel 初始化，无旧 trigger/view 引用 images。'
        : ''
      logger.warn({ message: '分组去抖重建失败', details: { userId, error: e.message + hint } })
    }
  }
})

module.exports = {
  scheduleUserRebuild
}
