const { createBullQueue } = require('../utils/bullmq/createBullQueue')
const logger = require('../utils/logger')
const { closeBullResources } = require('../utils/bullmq/closeBullResources')

const QUEUE_NAME = process.env.MAP_REGEO_QUEUE_NAME || 'mapRegeoQueue'

const { queue: mapRegeoQueue, connection } = createBullQueue({ name: QUEUE_NAME })

/**
 * 关闭逆地理编码队列及其 Redis 连接。
 * @returns {Promise<void>} 无返回值。
 */
async function closeMapRegeoQueue() {
  await closeBullResources({ queue: mapRegeoQueue, connection, logger, label: 'mapRegeoQueue' })
}

module.exports = {
  mapRegeoQueue,
  closeMapRegeoQueue,
  MAP_REGEO_QUEUE_NAME: QUEUE_NAME
}
