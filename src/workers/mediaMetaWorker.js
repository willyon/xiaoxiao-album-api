/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15
 * @Description: meta 阶段的 BullMQ Worker（调用 imageMetaIngestor）
 */
const logger = require('../utils/logger')
const { bullMqWillRetryAfterThisFailure } = require('../utils/bullmq/queuePipelineLifecycle')
const { setMetaPipelineStatus } = require('../services/mediaService')
const { processMediaMeta } = require('./mediaMetaIngestor')
const { createStandardWorker } = require('../utils/bullmq/createStandardWorker')

const QUEUE_NAME = process.env.MEDIA_META_QUEUE_NAME || 'media-meta'
const CONCURRENCY = Number(process.env.MEDIA_META_WORKER_CONCURRENCY || 1)

/**
 * Meta Worker 单任务处理入口：执行元数据处理并在终局失败时写入 failed 状态。
 * @param {import('bullmq').Job} job - BullMQ 任务对象。
 * @returns {Promise<void>} 无返回值。
 */
const processMediaMetaJob = async (job) => {
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
}

createStandardWorker({
  queueName: QUEUE_NAME,
  processor: processMediaMetaJob,
  concurrency: CONCURRENCY,
  logPrefix: 'mediaMetaWorker',
  onCompleted: (job) => {
    logger.info({
      message: `mediaMetaWorker completed job.id: ${job.id}`,
      details: { data: job.data }
    })
  }
})
