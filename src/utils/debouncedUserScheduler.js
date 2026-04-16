/**
 * 按 userId 去抖：同一 user 在 debounceMs 内多次 schedule，只在最后一次触发后的安静期结束时执行一次 execute(userId)。
 *
 * @param {Object} options
 * @param {number} options.debounceMs - 安静期毫秒数（调用方通常从环境变量解析）
 * @param {(userId: number) => void | Promise<void>} options.execute
 * @returns {{ schedule: (userId: number) => void }}
 */
function createDebouncedUserScheduler({ debounceMs, execute }) {
  const userTimers = new Map()
  const ms = Math.max(0, Number(debounceMs) || 0)

  function schedule(userId) {
    if (!userId) return

    if (userTimers.has(userId)) {
      clearTimeout(userTimers.get(userId))
    }

    const timer = setTimeout(() => {
      userTimers.delete(userId)
      const out = execute(userId)
      if (out != null && typeof out.then === 'function') {
        void out.catch(() => {})
      }
    }, ms)

    userTimers.set(userId, timer)
  }

  return { schedule }
}

module.exports = {
  createDebouncedUserScheduler
}
