const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.CLEANUP_QUEUE_NAME || "cleanupQueue";

const cleanupQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.CLEANUP_QUEUE_JOB_ATTEMPTS || 5),
    backoff: {
      type: "exponential",
      delay: Number(process.env.CLEANUP_QUEUE_JOB_BACKOFF_DELAY || 2000),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeCleanupQueue() {
  await cleanupQueue.close();
  await connection.quit();
}

module.exports = {
  cleanupQueue,
  queueConnection: connection,
  closeCleanupQueue,
};
