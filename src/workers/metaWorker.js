/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15
 * @Description: meta 阶段的 BullMQ Worker（调用 metaIngestor）
 */
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const logger = require("../utils/logger");
const { processImageMeta } = require("./metaIngestor");

const connection = new IORedis({ maxRetriesPerRequest: null });

const worker = new Worker(
  "image-meta",
  async (job) => {
    await processImageMeta(job.data);
  },
  { connection, concurrency: 2 }, // 元任务较重，先保守
);

worker.on("completed", (job) => {
  logger.info({ message: `metaWorker completed: ${job.id}`, details: { data: job.data } });
});

worker.on("failed", (job, err) => {
  logger.error({ message: `metaWorker failed: ${job?.id}`, stack: err?.stack, details: { data: job?.data } });
});

module.exports = worker;
