const { createBullQueue } = require('../utils/bullmq/createBullQueue')

const QUEUE_NAME = process.env.MAP_REGEO_QUEUE_NAME || 'mapRegeoQueue'

const { queue: mapRegeoQueue } = createBullQueue({ name: QUEUE_NAME })

module.exports = {
  mapRegeoQueue,
  MAP_REGEO_QUEUE_NAME: QUEUE_NAME
}
