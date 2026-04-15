const logger = require('../utils/logger')
const { cloudCaptionQueue } = require('../queues/cloudCaptionQueue')
const { selectPendingCloudCaptionBatch, countCloudAnalysisSkippedForUser } = require('../models/mediaModel')

/**
 * 设置页门闸：当前用户未删除且云阶段为 skipped 的条数（与历史补跑入队条件一致；失败请在处理中心重试）。
 */
function getCloudSkippedCount(userId) {
  return {
    skippedCount: countCloudAnalysisSkippedForUser(userId)
  }
}

/**
 * 单次请求内全量补跑：按 `id` 游标分页查询 skipped 并入队，不在入队时改库；Worker 终态再写 success/failed。
 * 每条任务使用固定 jobId `cloud-caption:{userId}:{mediaId}`，与同媒体的处理中心重试 `retry-cloud:…` 区分，并避免重复入队。
 * @returns {number} 入队总条数
 */
async function enqueueCloudCaptionRebuildAll(limitPerBatch = 500, userId) {
  const envIter = Number(process.env.CLOUD_CAPTION_REBUILD_MAX_ITERATIONS)
  const maxIter = Math.max(1, Math.min(Number.isFinite(envIter) && envIter > 0 ? envIter : 40, 100_000_000))
  let totalEnqueued = 0
  let cursorBeforeId = null

  for (let i = 0; i < maxIter; i++) {
    const rows = selectPendingCloudCaptionBatch(limitPerBatch, userId, cursorBeforeId)
    if (!rows || rows.length === 0) {
      return totalEnqueued
    }

    const jobs = rows.map((row) => {
      const uid = row.userId
      const mid = row.mediaId
      return {
        name: `cloud-caption-${mid}`,
        data: {
          mediaId: mid,
          userId: uid,
          highResStorageKey: row.highResStorageKey,
          originalStorageKey: row.originalStorageKey,
          mediaType: row.mediaType || 'image'
        },
        opts: {
          jobId: `cloud-caption:${uid}:${mid}`
        }
      }
    })

    await cloudCaptionQueue.addBulk(jobs)
    totalEnqueued += rows.length
    cursorBeforeId = rows[rows.length - 1].mediaId
  }

  const skippedLeft = countCloudAnalysisSkippedForUser(userId)
  logger.error({
    message: 'enqueueCloudCaptionRebuildAll: iteration cap reached (check CLOUD_CAPTION_REBUILD_MAX_ITERATIONS)',
    totalEnqueued,
    skippedLeft,
    maxIter,
    limitPerBatch
  })
  return totalEnqueued
}

module.exports = {
  getCloudSkippedCount,
  enqueueCloudCaptionRebuildAll
}
