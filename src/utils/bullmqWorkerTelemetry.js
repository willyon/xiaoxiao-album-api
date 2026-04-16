/*
 * BullMQ Worker 侧通用埋点：收敛 worker.on('failed') 中 willRetry / 日志级别 / details 结构，避免各 worker 复制样板。
 */
const logger = require('./logger')

/**
 * @param {import('bullmq').Worker} worker
 * @param {string} queueName 与队列名一致，写入 details.queue
 * @param {{ logPrefix?: string, resolveLevel?: (job: import('bullmq').Job|undefined, err: Error, ctx: { willRetry: boolean, maxAttempts: number }) => 'info'|'warn'|'error' }} [options]
 *   logPrefix 默认等于 queueName；resolveLevel 默认：将重试 warn，终局 error
 */
function attachStandardFailedLogging(worker, queueName, options = {}) {
  const logPrefix = options.logPrefix ?? queueName
  const resolveLevel =
    options.resolveLevel ??
    ((_job, _err, { willRetry }) => (willRetry ? 'warn' : 'error'))

  worker.on('failed', (job, error) => {
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
  })
}

module.exports = { attachStandardFailedLogging }
