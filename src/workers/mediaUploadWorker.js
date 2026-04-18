/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 16:42:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:00:09
 * @Description: 创建worker消费者任务
 */
const { ensureUserSetReady } = require('./userMediaHashset')
const { processAndSaveSingleMedia } = require('./mediaUploadIngestor')
const { createStandardWorker } = require('../utils/bullmq/createStandardWorker')

const QUEUE_NAME = process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload'
const CONCURRENCY = Number(process.env.MEDIA_UPLOAD_WORKER_CONCURRENCY || 1)

/**
 * 上传 Worker 的单任务处理入口：预热用户 hash 集合后处理单媒体。
 * @param {import('bullmq').Job} job - BullMQ 任务对象。
 * @returns {Promise<void>} 无返回值。
 */
const processMediaUploadJob = async (job) => {
  const { userId } = job.data
  //获取当前用户已存储在数据表中的全量hash集合 用于后续去重对比
  await ensureUserSetReady(userId)
  //图片处理
  await processAndSaveSingleMedia(job)
}

createStandardWorker({
  queueName: QUEUE_NAME,
  processor: processMediaUploadJob,
  concurrency: CONCURRENCY,
  logPrefix: 'mediaUploadWorker',
  failedLoggingOptions: {
  logPrefix: 'mediaUploadWorker',
  /**
   * 根据失败类型动态决定日志级别。
   * @param {import('bullmq').Job} _job - 当前任务（未使用）。
   * @param {Error & {code?:string}} error - 失败错误对象。
   * @param {{willRetry:boolean}} context - 重试上下文。
   * @returns {'info'|'warn'|'error'} 日志级别。
   */
  resolveLevel: (_job, error, { willRetry }) => {
    const isBusy = error && (error.code === 'IMG_BUSY' || /image_processing_in_progress/.test(error.message || ''))
    if (willRetry && isBusy) return 'info'
    if (willRetry) return 'warn'
    return 'error'
  }
  }
})

// createStandardWorker 已统一注册 stalled 监听与优雅退出
