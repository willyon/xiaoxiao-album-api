const logger = require('../utils/logger')
const { cloudCaptionQueue } = require('../queues/cloudCaptionQueue')
const mediaModel = require('../models/mediaModel')
const { enqueueRebuildAllByCursor } = require('../utils/bullmq/enqueueRebuildAllByCursor')

const { selectPendingCloudCaptionBatch, countCloudAnalysisSkippedForUser } = mediaModel

function _buildCloudCaptionJob(row) {
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
}

/**
 * 设置页门闸：当前用户未删除且云阶段为 skipped 的条数（与历史补跑入队条件一致；失败请在处理中心重试）。
 * @param {number|string} userId - 用户 ID。
 * @returns {{skippedCount:number}} 候选数量。
 */
function getCloudSkippedCount(userId) {
  return {
    skippedCount: countCloudAnalysisSkippedForUser(userId)
  }
}

/**
 * 单次请求内全量补跑：按 `id` 游标分页查询 skipped 并入队，不在入队时改库；Worker 终态再写 success/failed。
 * 每条任务使用固定 jobId `cloud-caption:{userId}:{mediaId}`，与同媒体的处理中心重试 `retry-cloud:…` 区分，并避免重复入队。
 * @param {number} [limitPerBatch=500] - 单批处理上限。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<number>} 入队总条数。
 */
async function enqueueCloudCaptionRebuildAll(limitPerBatch = 500, userId) {
  return enqueueRebuildAllByCursor({
    limitPerBatch,
    userId,
    selectBatch: selectPendingCloudCaptionBatch,
    buildJob: _buildCloudCaptionJob,
    addBulk: (jobs) => cloudCaptionQueue.addBulk(jobs),
    countPending: countCloudAnalysisSkippedForUser,
    logLabel: 'enqueueCloudCaptionRebuildAll',
    maxIterEnvKey: 'CLOUD_CAPTION_REBUILD_MAX_ITERATIONS',
    logger
  })
}

/** cloudCaptionIngestor：仅通过本服务访问下列 model 方法 */
/**
 * 更新云分析状态。
 * @param {number|string} mediaId - 媒体 ID。
 * @param {string} status - 云分析状态。
 * @returns {any} model 更新结果。
 */
function updateAnalysisStatusCloud(mediaId, status) {
  return mediaModel.updateAnalysisStatusCloud(mediaId, status)
}

/**
 * 写入/更新媒体 AI 分析字段。
 * @param {object} payload - AI 字段载荷。
 * @returns {any} model 更新结果。
 */
function upsertMediaAiFieldsForAnalysis(payload) {
  return mediaModel.upsertMediaAiFieldsForAnalysis(payload)
}

module.exports = {
  getCloudSkippedCount,
  enqueueCloudCaptionRebuildAll,
  updateAnalysisStatusCloud,
  upsertMediaAiFieldsForAnalysis
}
