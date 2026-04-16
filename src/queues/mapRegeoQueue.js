const { createBullQueue } = require('../utils/createBullQueue')

const QUEUE_NAME = process.env.MAP_REGEO_QUEUE_NAME || 'mapRegeoQueue'

const { queue: mapRegeoQueue, connection: mapRegeoQueueConnection } = createBullQueue({ name: QUEUE_NAME })

async function closeMapRegeoQueue() {
  await mapRegeoQueue.close()
  await mapRegeoQueueConnection.quit()
}

module.exports = {
  mapRegeoQueue,
  mapRegeoQueueConnection,
  closeMapRegeoQueue,
  MAP_REGEO_QUEUE_NAME: QUEUE_NAME
}
