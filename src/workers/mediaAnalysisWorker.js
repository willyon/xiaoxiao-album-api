/*
 * @Description: 媒体智能分析 Worker（消费 mediaAnalysisQueue）
 */
const logger = require('../utils/logger')
const { processMediaAnalysis } = require('./mediaAnalysisIngestor')
const { createStandardWorker } = require('../utils/bullmq/createStandardWorker')

const QUEUE_NAME = process.env.MEDIA_ANALYSIS_QUEUE_NAME || 'mediaAnalysisQueue'

/**
 * 解析媒体分析 Worker 并发度配置。
 * @returns {number} 并发数。
 */
function resolveWorkerConcurrency() {
  const envValue = Number(process.env.MEDIA_ANALYSIS_WORKER_CONCURRENCY)
  if (!Number.isNaN(envValue) && envValue > 0) return envValue
  return 2
}

const CONCURRENCY = resolveWorkerConcurrency()

/**
 * 处理单个媒体分析任务。
 * @param {import('bullmq').Job} job - BullMQ 任务对象。
 * @returns {Promise<void>} 无返回值。
 */
const processMediaAnalysisJob = async (job) => {
  await processMediaAnalysis(job)
}

createStandardWorker({
  queueName: QUEUE_NAME,
  processor: processMediaAnalysisJob,
  concurrency: CONCURRENCY,
  logPrefix: 'mediaAnalysisWorker',
  onCompleted: (job) => {
    logger.info({
      message: 'mediaAnalysisWorker.completed',
      details: { jobId: job.id, data: job.data }
    })
  }
})
