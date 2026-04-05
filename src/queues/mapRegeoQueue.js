const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.MAP_REGEO_QUEUE_NAME || "mapRegeoQueue";

const mapRegeoQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.MAP_REGEO_JOB_ATTEMPTS || 5),
    backoff: {
      type: "exponential",
      delay: Number(process.env.MAP_REGEO_JOB_BACKOFF_DELAY || 2000),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeMapRegeoQueue() {
  await mapRegeoQueue.close();
  await connection.quit();
}

module.exports = {
  mapRegeoQueue,
  mapRegeoQueueConnection: connection,
  closeMapRegeoQueue,
  MAP_REGEO_QUEUE_NAME: QUEUE_NAME,
};
