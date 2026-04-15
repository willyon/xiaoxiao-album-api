const logger = require('../utils/logger')
const cleanupGroupingService = require('./cleanupGroupingService')

// 用户级去抖计时器
const userTimers = new Map()
// 用户级最大延迟计时器（确保即使有大量图片处理，也能定期重建）
const userMaxDelayTimers = new Map()
// 记录首次调度时间
const userFirstScheduleTime = new Map()

// 去抖间隔（毫秒），默认 1 分钟，可通过环境变量覆盖
// 批量导入场景：更希望在“导入结束后”再重建，因此默认放大去抖时间
const DEBOUNCE_MS = Number(process.env.CLEANUP_GROUPING_DEBOUNCE_MS || 1 * 60 * 1000)
// 最大延迟时间（毫秒）。默认关闭（0），以确保只在导入停止后重建；
// 如需在持续导入时也周期重建，可设置为正数（例如 30*60*1000）。
const MAX_DELAY_MS = Number(process.env.CLEANUP_GROUPING_MAX_DELAY_MS || 0)

function scheduleUserRebuild(userId) {
  if (!userId) return

  const now = Date.now()
  const firstScheduleTime = userFirstScheduleTime.get(userId)

  // 如果是首次调度，记录时间并设置最大延迟计时器
  if (!firstScheduleTime) {
    userFirstScheduleTime.set(userId, now)

    // 设置最大延迟计时器，确保即使有大量图片处理，也能定期重建
    if (MAX_DELAY_MS > 0) {
      if (userMaxDelayTimers.has(userId)) {
        clearTimeout(userMaxDelayTimers.get(userId))
      }
      const maxDelayTimer = setTimeout(() => {
        userMaxDelayTimers.delete(userId)
        userFirstScheduleTime.delete(userId)
        // 清除去抖计时器，强制立即重建
        if (userTimers.has(userId)) {
          clearTimeout(userTimers.get(userId))
          userTimers.delete(userId)
        }
        // 立即执行重建
        _executeRebuild(userId)
      }, MAX_DELAY_MS)
      userMaxDelayTimers.set(userId, maxDelayTimer)
    }
  }

  // 重置去抖计时器
  if (userTimers.has(userId)) {
    clearTimeout(userTimers.get(userId))
  }
  const timer = setTimeout(() => {
    userTimers.delete(userId)
    // 清除最大延迟计时器和首次调度时间
    if (userMaxDelayTimers.has(userId)) {
      clearTimeout(userMaxDelayTimers.get(userId))
      userMaxDelayTimers.delete(userId)
    }
    userFirstScheduleTime.delete(userId)
    _executeRebuild(userId)
  }, DEBOUNCE_MS)
  userTimers.set(userId, timer)
}

function _executeRebuild(userId) {
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

module.exports = {
  scheduleUserRebuild
}
