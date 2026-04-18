const { createBullQueue } = require('../utils/bullmq/createBullQueue')
const logger = require('../utils/logger')
const { closeBullResources } = require('../utils/bullmq/closeBullResources')

const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || 'cloudCaptionQueue'

const { queue: cloudCaptionQueue, connection } = createBullQueue({ name: QUEUE_NAME })

/**
 * 关闭云描述队列及其 Redis 连接。
 * @returns {Promise<void>} 无返回值。
 */
async function closeCloudCaptionQueue() {
  await closeBullResources({ queue: cloudCaptionQueue, connection, logger, label: 'cloudCaptionQueue' })
}

module.exports = {
  cloudCaptionQueue,
  closeCloudCaptionQueue,
  CLOUD_CAPTION_QUEUE_NAME: QUEUE_NAME
}
