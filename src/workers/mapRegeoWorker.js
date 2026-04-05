require("dotenv").config();
const { Worker } = require("bullmq");
const IORedis = require("ioredis");

const logger = require("../utils/logger");
const initGracefulShutdown = require("../utils/gracefulShutdown");
const { processMapRegeoJob } = require("./mapRegeoIngestor");
const { MAP_REGEO_QUEUE_NAME } = require("../queues/mapRegeoQueue");

const connection = new IORedis({ maxRetriesPerRequest: null });
const QUEUE_NAME = MAP_REGEO_QUEUE_NAME;

const worker = new Worker(QUEUE_NAME, processMapRegeoJob, {
  connection,
  concurrency: Math.max(1, Math.min(Number(process.env.MAP_REGEO_WORKER_CONCURRENCY || 3), 20)),
});

logger.info({ message: `mapRegeoWorker 已启动，队列名=${QUEUE_NAME}` });

worker.on("stalled", (jobId) => {
  logger.warn({ message: "mapRegeoWorker.stalled", details: { jobId } });
});

initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()],
});

module.exports = {
  worker,
};
