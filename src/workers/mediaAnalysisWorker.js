/*
 * @Description: 媒体智能分析 Worker（消费 mediaAnalysisQueue）
 */
const { Worker } = require('bullmq')
const IORedis = require('ioredis')
const logger = require('../utils/logger')
const { attachStandardFailedLogging } = require('../utils/bullmqWorkerTelemetry')
const initGracefulShutdown = require('../utils/gracefulShutdown')
const { processMediaAnalysis } = require('./mediaAnalysisIngestor')

const connection = new IORedis({ maxRetriesPerRequest: null })

const QUEUE_NAME = process.env.MEDIA_ANALYSIS_QUEUE_NAME || 'mediaAnalysisQueue'

function resolveWorkerConcurrency() {
  const envValue = Number(process.env.MEDIA_ANALYSIS_WORKER_CONCURRENCY)
  if (!Number.isNaN(envValue) && envValue > 0) return envValue
  return 2
}

const CONCURRENCY = resolveWorkerConcurrency()

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await processMediaAnalysis(job)
  },
  { connection, concurrency: CONCURRENCY }
)

logger.info({ message: `mediaAnalysisWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}` })

worker.on('completed', (job) => {
  logger.info({
    message: 'mediaAnalysisWorker.completed',
    details: { jobId: job.id, data: job.data }
  })
})

attachStandardFailedLogging(worker, QUEUE_NAME, { logPrefix: 'mediaAnalysisWorker' })

worker.on('stalled', (jobId) => {
  logger.warn({ message: 'mediaAnalysisWorker.stalled', details: { jobId } })
})

initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()]
})

module.exports = worker
