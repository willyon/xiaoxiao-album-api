/**
 * 按 userId 去抖：同一 user 在 debounceMs 内多次 schedule，只在最后一次触发后的安静期结束时执行一次 execute(userId)。
 *
 * @param {{debounceMs:number,execute:(userId: number) => void | Promise<void>}} options - 去抖配置。
 * @returns {{ schedule: (userId: number) => void }} 调度器对象。
 */
function createDebouncedUserScheduler({ debounceMs, execute }) {
  const userTimers = new Map()
  const ms = Math.max(0, Number(debounceMs) || 0)

  /**
   * 调度指定用户的去抖任务。
   * @param {number} userId - 用户 ID。
   * @returns {void} 无返回值。
   */
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
