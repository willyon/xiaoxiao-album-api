/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 16:42:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-14 23:32:34
 * @Description: 创建worker消费者任务
 */
require("dotenv").config();
const { Worker } = require("bullmq");
const Redis = require("ioredis");
const { processAndSaveSingleImage } = require("./imageIngestor");
const logger = require("../utils/logger");
const initGracefulShutdown = require("../utils/gracefulShutdown");
const { ensureUserSetReady } = require("./sharedEnsure");

const connection = new Redis({
  // 在BullMQ场景下设为null可以避免ioredis在命令阻塞时抛MaxRetriesPerRequesterror,是必要的设置
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "upload",
  async (job) => {
    const { userId } = job.data;
    //获取当前用户已存储在数据表中的全量hash集合 用于后续去重对比
    await ensureUserSetReady(userId);
    //图片处理
    await processAndSaveSingleImage(job.data);
  },
  { connection, concurrency: 2 }, //一次最多同时并发4个任务
);

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} 处理完成`);
});

worker.on("failed", (job, error) => {
  const maxAttempts = job.opts?.attempts || 0;
  const willRetry = job.attemptsMade < maxAttempts;
  const isBusy = error && (error.code === "IMG_BUSY" || /image_processing_in_progress/.test(error.message || ""));
  const level = willRetry && isBusy ? "info" : willRetry ? "warn" : "error";

  logger[level]({
    message: `Job ${job.id} 处理失败${willRetry ? "（将重试）" : "（已达最大重试）"}: ${error?.message}`,
    stack: level === "error" ? error?.stack : undefined,
    details: {
      step: "uploadWorker",
      attemptsMade: job.attemptsMade,
      maxAttempts,
      code: error?.code,
      fileInfo: job.data,
    },
  });
});

// 注册优雅退出：先停止领取新任务，再关闭底层 Redis 连接
initGracefulShutdown({
  // worker 进程没有 HTTP server，可不传
  extraClosers: [async () => worker.close(), async () => connection.quit()],
});
