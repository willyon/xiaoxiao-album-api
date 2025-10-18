/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @LastEditors: zhangshouchangs
 * @LastEditTime: 2025-01-28
 * @Description: 搜索索引处理 Worker
 */
require("dotenv").config();
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const logger = require("../utils/logger");
const initGracefulShutdown = require("../utils/gracefulShutdown");
// const { processSearchIndex } = require("./searchIndexIngestor");
const { processFaceRecognition } = require("./searchIndexIngestor");

// 在BullMQ场景下设为null可以避免ioredis在命令阻塞时抛MaxRetriesPerRequesterror,是必要的设置
const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.SEARCH_INDEX_QUEUE_NAME;
const CONCURRENCY = Number(process.env.IMAGE_SEARCH_INDEX_WORKER_CONCURRENCY || 1);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await processFaceRecognition(job);
  },
  { connection, concurrency: CONCURRENCY },
);
logger.info({ message: `searchIndexWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}` });

// —— 运行时事件：完成 / 失败（带重试意识的日志等级）——
worker.on("completed", (job) => {
  logger.info({
    message: `searchIndexWorker completed, job.id: ${job.id}`,
    details: { data: job.data },
  });
});

worker.on("failed", (job, error) => {
  const maxAttempts = job?.opts?.attempts || 0;
  const willRetry = (job?.attemptsMade || 0) < maxAttempts;

  const level = willRetry ? "warn" : "error";

  logger[level]({
    message: `searchIndexWorker failed job.id: ${job?.id} ${willRetry ? "（将重试）" : "（已达最大重试）"}`,
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
  logger.warn({ message: `searchIndexWorker stalled: ${job?.id}` });
});

// —— 优雅退出：先停止领取新任务，再关闭底层 ioRedis 连接 ——
// 注意：和 uploadWorker 的处理方式保持一致，方便统一维护
initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()],
});

module.exports = worker;
