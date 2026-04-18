/*
 * @Description: 云 Caption 队列 BullMQ Worker（业务逻辑见 cloudCaptionIngestor.js）
 */
const { processCloudCaptionJob } = require('./cloudCaptionIngestor')
const { createStandardWorker } = require('../utils/bullmq/createStandardWorker')
const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || 'cloudCaptionQueue'
createStandardWorker({
  queueName: QUEUE_NAME,
  processor: processCloudCaptionJob,
  logPrefix: 'cloudCaptionWorker'
})
