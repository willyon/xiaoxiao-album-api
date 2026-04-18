const { processMapRegeoJob } = require('./mapRegeoIngestor')
const { MAP_REGEO_QUEUE_NAME } = require('../queues/mapRegeoQueue')
const { createStandardWorker } = require('../utils/bullmq/createStandardWorker')
const QUEUE_NAME = MAP_REGEO_QUEUE_NAME
createStandardWorker({
  queueName: QUEUE_NAME,
  processor: processMapRegeoJob,
  concurrency: Math.max(1, Math.min(Number(process.env.MAP_REGEO_WORKER_CONCURRENCY || 3), 20))
})
