/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 16:42:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:00:09
 * @Description: 创建worker消费者任务
 */
require('dotenv').config()
const { Worker } = require('bullmq')
const Redis = require('ioredis')
const logger = require('../utils/logger')
const initGracefulShutdown = require('../utils/gracefulShutdown')
const { ensureUserSetReady } = require('./userMediaHashset')
const { processAndSaveSingleMedia } = require('./mediaUploadIngestor')
// const PROFILE = process.env.PROFILE_UPLOAD === "1";

const connection = new Redis({
  // 在BullMQ场景下设为null可以避免ioredis在命令阻塞时抛MaxRetriesPerRequesterror,是必要的设置
  maxRetriesPerRequest: null
})

const QUEUE_NAME = process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload'
const CONCURRENCY = Number(process.env.MEDIA_UPLOAD_WORKER_CONCURRENCY || 1)

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { userId } = job.data
    //获取当前用户已存储在数据表中的全量hash集合 用于后续去重对比
    await ensureUserSetReady(userId)
    //图片处理
    await processAndSaveSingleMedia(job)
  },
  { connection, concurrency: CONCURRENCY } //一次最多同时并发4个任务
)
logger.info({ message: `mediaUploadWorker 已启动，队列名=${QUEUE_NAME}，并发数=${CONCURRENCY}` })

worker.on('active', (_job) => {
  // if (PROFILE) {
  //   const waitMs = job.processedOn && job.timestamp ? job.processedOn - job.timestamp : 0; // 回退
  //   logger.info({
  //     message: `upload.active jobID:${job.id}, 队列等待时长:, ${Math.floor(waitMs / 1000)}秒 processedOn:${job.processedOn}timestamp:${job.timestamp}`,
  //   });
  // }
})

worker.on('completed', (_job) => {
  // logger.info({
  //   message: `imageUploadWorker completed: ${job.id}`,
  // });
  // if (PROFILE) {
  //   const runMs = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined; // 回退到你之前的 __start 也行
  //   logger.info({
  //     message: `upload.done jobID:${job.id}, 任务执行时长:${Math.floor(runMs / 1000)}秒`,
  //   });
  // }
})

worker.on('failed', (job, error) => {
  // if (PROFILE) {
  //   const runMs = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
  //   logger.warn({
  //     message: `upload.fail jobID:${job.id}, 任务执行时长:${Math.floor(runMs / 1000)}`,
  //   });
  // }
  const maxAttempts = job.opts?.attempts || 0
  const willRetry = (job?.attemptsMade || 0) < maxAttempts

  const isBusy = error && (error.code === 'IMG_BUSY' || /image_processing_in_progress/.test(error.message || ''))

  const level = willRetry && isBusy ? 'info' : willRetry ? 'warn' : 'error'

  logger[level]({
    message: `mediaUploadWorker failed: ${job?.id} ${willRetry ? '（将重试）' : '（已达最大重试）'}`,
    stack: level === 'error' ? error?.stack : undefined,
    details: {
      queue: QUEUE_NAME,
      attemptsMade: job?.attemptsMade,
      maxAttempts,
      error: error?.message,
      data: job?.data
    }
  })
})

worker.on('stalled', (job) => {
  logger.warn(`mediaUploadWorker stalled: ${job?.id}`)
})

// 注册优雅退出：先停止领取新任务，再关闭底层 Redis 连接
initGracefulShutdown({
  // worker 进程没有 HTTP server，可不传
  extraClosers: [async () => worker.close(), async () => connection.quit()]
})
