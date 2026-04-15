const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { QUEUE_JOB_ATTEMPTS } = require("../config/queueConfig");

const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || "cloudCaptionQueue";

const cloudCaptionQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: QUEUE_JOB_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: Number(process.env.CLOUD_CAPTION_JOB_BACKOFF_DELAY || 2000),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeCloudCaptionQueue() {
  await cloudCaptionQueue.close();
  await connection.quit();
}

module.exports = {
  cloudCaptionQueue,
  cloudCaptionQueueConnection: connection,
  closeCloudCaptionQueue,
};

