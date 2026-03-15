/*
 * @Description: 媒体智能分析 Worker（消费 mediaAnalysisQueue）
 */
require("dotenv").config();
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const logger = require("../utils/logger");
const initGracefulShutdown = require("../utils/gracefulShutdown");
const { processMediaAnalysis } = require("./mediaAnalysisIngestor");

const connection = new IORedis({ maxRetriesPerRequest: null });

const QUEUE_NAME = process.env.MEDIA_ANALYSIS_QUEUE_NAME || "mediaAnalysisQueue";

function resolveWorkerConcurrency() {
  const envValue = Number(process.env.MEDIA_ANALYSIS_WORKER_CONCURRENCY);
  if (!Number.isNaN(envValue) && envValue > 0) return envValue;
  const profile = (process.env.AI_ANALYSIS_PROFILE || "standard").toLowerCase();
  if (profile === "standard") return 2;
  if (profile === "enhanced") return 4;
  return 2;
}

const CONCURRENCY = resolveWorkerConcurrency();

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await processMediaAnalysis(job);
  },
  { connection, concurrency: CONCURRENCY },
);

logger.info({ message: `mediaAnalysisWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}` });

worker.on("completed", (job) => {
  logger.info({
    message: "mediaAnalysisWorker.completed",
    details: { jobId: job.id, data: job.data },
  });
});

worker.on("failed", (job, error) => {
  const maxAttempts = job?.opts?.attempts || 0;
  const willRetry = (job?.attemptsMade || 0) < maxAttempts;
  const level = willRetry ? "warn" : "error";
  logger[level]({
    message: "mediaAnalysisWorker.failed",
    details: {
      queue: QUEUE_NAME,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      maxAttempts,
      error: error?.message,
      data: job?.data,
    },
  });
});

worker.on("stalled", (job) => {
  logger.warn({
    message: "mediaAnalysisWorker.stalled",
    details: { jobId: job?.id },
  });
});

initGracefulShutdown({
  extraClosers: [async () => worker.close(), async () => connection.quit()],
});

module.exports = worker;
