const { createBullQueue } = require('../utils/bullmq/createBullQueue')

const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || 'cloudCaptionQueue'

const { queue: cloudCaptionQueue } = createBullQueue({ name: QUEUE_NAME })

module.exports = {
  cloudCaptionQueue
}
