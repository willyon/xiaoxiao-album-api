/*
 * @Description: Queue runtime config
 */

/**
 * 将值转换为正整数，不合法时返回默认值。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @returns {number} 正整数结果。
 */
function toPositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

const QUEUE_JOB_ATTEMPTS = toPositiveInt(process.env.QUEUE_JOB_ATTEMPTS, 3)
const QUEUE_JOB_BACKOFF_DELAY = toPositiveInt(process.env.QUEUE_JOB_BACKOFF_DELAY, 2000)

module.exports = {
  QUEUE_JOB_ATTEMPTS,
  QUEUE_JOB_BACKOFF_DELAY
}
