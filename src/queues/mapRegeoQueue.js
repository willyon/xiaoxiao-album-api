const { Queue } = require('bullmq')
const IORedis = require('ioredis')
const { QUEUE_JOB_ATTEMPTS, QUEUE_JOB_BACKOFF_DELAY } = require('../config/queueConfig')

const connection = new IORedis({ maxRetriesPerRequest: null })

const QUEUE_NAME = process.env.MAP_REGEO_QUEUE_NAME || 'mapRegeoQueue'

const mapRegeoQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: QUEUE_JOB_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: QUEUE_JOB_BACKOFF_DELAY
    },
    removeOnComplete: true,
    removeOnFail: 200
  }
})

async function closeMapRegeoQueue() {
  await mapRegeoQueue.close()
  await connection.quit()
}

module.exports = {
  mapRegeoQueue,
  mapRegeoQueueConnection: connection,
  closeMapRegeoQueue,
  MAP_REGEO_QUEUE_NAME: QUEUE_NAME
}
