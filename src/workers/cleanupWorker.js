/*
 * @Description: 智能清理队列 Worker
 */
require("dotenv").config();
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const logger = require("../utils/logger");
const initGracefulShutdown = require("../utils/gracefulShutdown");
const { processCleanupScan } = require("./cleanupIngestor");

const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.CLEANUP_QUEUE_NAME || "cleanupQueue";
const CONCURRENCY = Number(process.env.CLEANUP_WORKER_CONCURRENCY || 1);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await processCleanupScan(job);
  },
  { connection, concurrency: CONCURRENCY },
);

logger.info({
  message: `cleanupWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}`,
});

worker.on("completed", (job) => {
  logger.info({
    message: `cleanupWorker completed, job.id: ${job.id}`,
    details: { data: job.data },
  });
});

worker.on("failed", (job, error) => {
  const maxAttempts = job?.opts?.attempts || 0;
  const willRetry = (job?.attemptsMade || 0) < maxAttempts;
  const level = willRetry ? "warn" : "error";
  logger[level]({
    message: `cleanupWorker failed job.id: ${job?.id} ${willRetry ? "（将重试）" : "（已达最大重试）"}`,
    stack: level === "error" ? error?.stack : undefined,
    details: {
      queue: QUEUE_NAME,
      attemptsMade: job?.attemptsMade,
      maxAttempts,
      error: error?.message,
      data: job?.data,
    },
  });
});

worker.on("stalled", (job) => {
  logger.warn({ message: `cleanupWorker stalled: ${job?.id}` });
});

initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()],
});

module.exports = worker;
