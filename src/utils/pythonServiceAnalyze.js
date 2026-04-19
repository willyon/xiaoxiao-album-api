/**
 * Python 分析服务：与各 Ingestor 共享的超时（ANALYZE_*_TIMEOUT_MS）及 axios validateStatus 场景下的非 2xx 错误构造。
 */
const { UnrecoverableError } = require('bullmq')

const ANALYZE_IMAGE_TIMEOUT_MS = Number(process.env.ANALYZE_IMAGE_TIMEOUT_MS || 120000)
const ANALYZE_VIDEO_TIMEOUT_MS = Number(process.env.ANALYZE_VIDEO_TIMEOUT_MS || 600000)

/**
 * @param {string} prefix - 错误前缀。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} bodyText - 响应体（可序列化片段）。
 * @returns {Error} 5xx/429 可重试为普通 Error，其余为 UnrecoverableError。
 */
function makePythonServiceNon2xxError(prefix, status, bodyText) {
  const text = String(bodyText || '').slice(0, 200)
  const message = `${prefix}_${status}: ${text}`
  if (status >= 500 || status === 429) {
    return new Error(message)
  }
  return new UnrecoverableError(message)
}

module.exports = {
  ANALYZE_IMAGE_TIMEOUT_MS,
  ANALYZE_VIDEO_TIMEOUT_MS,
  makePythonServiceNon2xxError
}
