let inFlight = 0
const queue = []

/**
 * 解析 AI 并发上限配置。
 * @returns {number} 并发上限。
 */
function resolveMax() {
  const raw = Number(process.env.AI_MAX_CONCURRENCY)
  if (!Number.isNaN(raw) && raw > 0) return raw
  return 1
}

/**
 * 申请一个并发槽位。
 * @returns {Promise<void>} 槽位可用时返回。
 */
async function acquire() {
  const max = resolveMax()
  if (inFlight < max) {
    inFlight += 1
    return
  }
  return new Promise((resolve) => queue.push(resolve))
}

/**
 * 释放一个并发槽位，并唤醒队列中的下一个请求。
 * @returns {void} 无返回值。
 */
function release() {
  inFlight -= 1
  if (inFlight < 0) inFlight = 0
  if (queue.length > 0) {
    inFlight += 1
    const next = queue.shift()
    next()
  }
}

/**
 * 在 AI 并发槽位内执行异步任务。
 * @template T
 * @param {() => Promise<T>} fn - 需要执行的异步任务。
 * @returns {Promise<T>} 任务结果。
 */
async function withAiSlot(fn) {
  await acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}

module.exports = {
  withAiSlot
}
