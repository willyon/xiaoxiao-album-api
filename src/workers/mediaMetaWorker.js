/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15
 * @Description: meta 阶段的 BullMQ Worker（调用 imageMetaIngestor）
 */
require("dotenv").config();
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const logger = require("../utils/logger");
const initGracefulShutdown = require("../utils/gracefulShutdown");
const { processMediaMeta } = require("./mediaMetaIngestor");

// 与上传 Worker 保持一致：BullMQ 场景下建议设为 null，避免 ioredis 在阻塞命令时抛 MaxRetriesPerRequestError
const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.MEDIA_META_QUEUE_NAME || "media-meta";
const CONCURRENCY = Number(process.env.MEDIA_META_WORKER_CONCURRENCY || 1);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await processMediaMeta(job);
  },
  { connection, concurrency: CONCURRENCY },
);
logger.info({ message: `mediaMetaWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}` });

// —— 运行时事件：完成 / 失败（带重试意识的日志等级）——
worker.on("completed", (job) => {
  logger.info({
    message: `mediaMetaWorker completed job.id: ${job.id}`,
    details: { data: job.data },
  });
});

worker.on("failed", (job, error) => {
  const maxAttempts = job?.opts?.attempts || 0;
  const willRetry = (job?.attemptsMade || 0) < maxAttempts;

  const level = willRetry ? "warn" : "error";

  logger[level]({
    message: `mediaMetaWorker failed: ${job?.id} ${willRetry ? "（将重试）" : "（已达最大重试）"}`,
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
  logger.warn(`mediaMetaWorker stalled: ${job?.id}`);
});

// —— 优雅退出：先停止领取新任务，再关闭底层 Redis 连接 ——
// 注意：和 uploadWorker 的处理方式保持一致，方便统一维护
initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()],
});

module.exports = worker;
