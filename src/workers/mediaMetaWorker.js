/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15
 * @Description: meta 阶段的 BullMQ Worker（调用 imageMetaIngestor）
 */
require('dotenv').config()
const { Worker } = require('bullmq')
const IORedis = require('ioredis')
const logger = require('../utils/logger')
const initGracefulShutdown = require('../utils/gracefulShutdown')
const { bullMqWillRetryAfterThisFailure } = require('../utils/queuePipelineLifecycle')
const { setMetaPipelineStatus } = require('../services/mediaService')
const { processMediaMeta } = require('./mediaMetaIngestor')

const connection = new IORedis({ maxRetriesPerRequest: null })

const QUEUE_NAME = process.env.MEDIA_META_QUEUE_NAME || 'media-meta'
const CONCURRENCY = Number(process.env.MEDIA_META_WORKER_CONCURRENCY || 1)

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    try {
      await processMediaMeta(job)
    } catch (err) {
      const { userId, imageHash } = job.data || {}
      // meta 终局 failed 仅此一处落库（与 mediaMetaIngestor 解耦，避免与 _handleMetaRetryFailure 重复 UPDATE）
      if (userId && imageHash && !bullMqWillRetryAfterThisFailure(job, err)) {
        await setMetaPipelineStatus({ userId, imageHash, metaPipelineStatus: 'failed' })
      }
      throw err
    }
  },
  { connection, concurrency: CONCURRENCY }
)
logger.info({ message: `mediaMetaWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}` })

worker.on('completed', (job) => {
  logger.info({
    message: `mediaMetaWorker completed job.id: ${job.id}`,
    details: { data: job.data }
  })
})

worker.on('failed', (job, error) => {
  const maxAttempts = job?.opts?.attempts || 0
  const willRetry = (job?.attemptsMade || 0) < maxAttempts
  const level = willRetry ? 'warn' : 'error'
  logger[level]({
    message: `mediaMetaWorker failed: ${job?.id} ${willRetry ? '（将重试）' : '（已达最大重试）'}`,
    stack: level === 'error' ? error?.stack : undefined,
    details: {
      queue: QUEUE_NAME,
      attemptsMade: job?.attemptsMade,
      maxAttempts,
      error: error?.message,
      data: job?.data
    }
  })
})

worker.on('stalled', (jobId) => {
  logger.warn({ message: 'mediaMetaWorker.stalled', details: { jobId } })
})

initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()]
})

module.exports = worker
