/*
 * BullMQ Worker 侧通用埋点：收敛 worker.on('failed') 中 willRetry / 日志级别 / details 结构，避免各 worker 复制样板。
 */
const logger = require('../logger')

/**
 * 默认失败日志级别解析：可重试为 warn，终局失败为 error。
 * @param {import('bullmq').Job|undefined} _job - 任务对象（未使用）。
 * @param {Error} _err - 错误对象（未使用）。
 * @param {{willRetry:boolean}} context - 重试上下文。
 * @returns {'warn'|'error'} 日志级别。
 */
function defaultResolveLevel(_job, _err, { willRetry }) {
  return willRetry ? 'warn' : 'error'
}

/**
 * 生成 worker failed 事件处理器。
 * @param {string} queueName - 队列名。
 * @param {string} logPrefix - 日志前缀。
 * @param {(job: import('bullmq').Job|undefined, err: Error, ctx: { willRetry: boolean, maxAttempts: number }) => 'info'|'warn'|'error'} resolveLevel - 日志级别解析器。
 * @returns {(job: import('bullmq').Job|undefined, error: Error) => void} failed 事件处理函数。
 */
function createFailedHandler(queueName, logPrefix, resolveLevel) {
  return (job, error) => {
    const maxAttempts = job?.opts?.attempts || 0
    const willRetry = (job?.attemptsMade || 0) < maxAttempts
    const level = resolveLevel(job, error, { willRetry, maxAttempts })

    logger[level]({
      message: `${logPrefix} failed: ${job?.id} ${willRetry ? '（将重试）' : '（已达最大重试）'}`,
      stack: level === 'error' ? error?.stack : undefined,
      details: {
        queue: queueName,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        maxAttempts,
        error: error?.message,
        data: job?.data
      }
    })
  }
}

/**
 * 绑定 Worker failed 事件并输出统一日志结构。
 * @param {import('bullmq').Worker} worker - BullMQ Worker。
 * @param {string} queueName - 队列名（写入 details.queue）。
 * @param {{ logPrefix?: string, resolveLevel?: (job: import('bullmq').Job|undefined, err: Error, ctx: { willRetry: boolean, maxAttempts: number }) => 'info'|'warn'|'error' }} [options]
 *   logPrefix 默认等于 queueName；resolveLevel 默认：将重试 warn，终局 error
 * @returns {void} 无返回值。
 */
function attachStandardFailedLogging(worker, queueName, options = {}) {
  const logPrefix = options.logPrefix ?? queueName
  const resolveLevel = options.resolveLevel ?? defaultResolveLevel
  worker.on('failed', createFailedHandler(queueName, logPrefix, resolveLevel))
}

module.exports = { attachStandardFailedLogging }
