const { createBullQueue } = require('../utils/createBullQueue')

const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || 'cloudCaptionQueue'

const { queue: cloudCaptionQueue, connection: cloudCaptionQueueConnection } = createBullQueue({ name: QUEUE_NAME })

async function closeCloudCaptionQueue() {
  await cloudCaptionQueue.close()
  await cloudCaptionQueueConnection.quit()
}

module.exports = {
  cloudCaptionQueue,
  cloudCaptionQueueConnection,
  closeCloudCaptionQueue
}
