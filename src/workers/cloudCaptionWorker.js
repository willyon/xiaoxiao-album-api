/*
 * @Description: 云 Caption 队列 BullMQ Worker（业务逻辑见 cloudCaptionIngestor.js）
 */
const { Worker } = require('bullmq')
const IORedis = require('ioredis')

const logger = require('../utils/logger')
const { attachStandardFailedLogging } = require('../utils/bullmqWorkerTelemetry')
const initGracefulShutdown = require('../utils/gracefulShutdown')
const { processCloudCaptionJob } = require('./cloudCaptionIngestor')

const connection = new IORedis({ maxRetriesPerRequest: null })
const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || 'cloudCaptionQueue'

const worker = new Worker(QUEUE_NAME, processCloudCaptionJob, {
  connection
})

logger.info({ message: `cloudCaptionWorker 已启动，队列名=${QUEUE_NAME}` })

attachStandardFailedLogging(worker, QUEUE_NAME, { logPrefix: 'cloudCaptionWorker' })

worker.on('stalled', (jobId) => {
  logger.warn({ message: 'cloudCaptionWorker.stalled', details: { jobId } })
})

initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()]
})

module.exports = {
  worker
}
