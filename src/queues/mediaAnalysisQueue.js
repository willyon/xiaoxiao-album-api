/*
 * 媒体智能分析统一队列（Phase 0 骨架）
 * 文档：docs/图片智能分析链路补齐-详细执行方案.md
 * 启用方式：USE_MEDIA_ANALYSIS_QUEUE=true 时由 imageMetaIngestor 入队
 */
const { createBullQueue } = require('../utils/bullmq/createBullQueue')
const logger = require('../utils/logger')
const { closeBullResources } = require('../utils/bullmq/closeBullResources')

const QUEUE_NAME = process.env.MEDIA_ANALYSIS_QUEUE_NAME || 'mediaAnalysisQueue'

const { queue: mediaAnalysisQueue, connection } = createBullQueue({ name: QUEUE_NAME })

/**
 * 关闭媒体分析队列及其 Redis 连接。
 * @returns {Promise<void>} 无返回值。
 */
async function closeMediaAnalysisQueue() {
  await closeBullResources({ queue: mediaAnalysisQueue, connection, logger, label: 'mediaAnalysisQueue' })
}

module.exports = {
  mediaAnalysisQueue,
  closeMediaAnalysisQueue
}
