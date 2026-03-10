/*
 * 媒体智能分析统一队列（Phase 0 骨架）
 * 文档：docs/图片智能分析链路补齐-详细执行方案.md
 * 启用方式：USE_MEDIA_ANALYSIS_QUEUE=true 时由 imageMetaIngestor 入队
 */
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.MEDIA_ANALYSIS_QUEUE_NAME || "mediaAnalysisQueue";

const mediaAnalysisQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.MEDIA_ANALYSIS_JOB_ATTEMPTS || 5),
    backoff: {
      type: "exponential",
      delay: Number(process.env.MEDIA_ANALYSIS_JOB_BACKOFF_DELAY || 2000),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeMediaAnalysisQueue() {
  await mediaAnalysisQueue.close();
  await connection.quit();
}

module.exports = {
  mediaAnalysisQueue,
  queueConnection: connection,
  closeMediaAnalysisQueue,
};
