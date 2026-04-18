const logger = require('../utils/logger')
const { mapRegeoQueue } = require('../queues/mapRegeoQueue')
const mediaModel = require('../models/mediaModel')
const { enqueueRebuildAllByCursor } = require('../utils/bullmq/enqueueRebuildAllByCursor')

const { selectPendingMapRegeoBatch, countMapRegeoSkippedForUser } = mediaModel

function _buildMapRegeoJob(row) {
  const uid = row.userId
  const mid = row.mediaId
  return {
    name: `map-regeo-${mid}`,
    data: {
      mediaId: mid,
      userId: uid,
      latitude: row.latitude,
      longitude: row.longitude
    },
    opts: {
      jobId: `map-regeo:${uid}:${mid}`
    }
  }
}

/** 设置页展示：map_regeo_status 为 skipped 或 failed、且含 GPS 的条数 */
/**
 * 获取用户逆地理补跑候选数量。
 * @param {number|string} userId - 用户 ID。
 * @returns {{skippedCount:number}} 候选数量。
 */
function getMapRegeoSkippedCount(userId) {
  return {
    skippedCount: countMapRegeoSkippedForUser(userId)
  }
}

/**
 * 按 id 游标分页查询 map_regeo_status ∈ {skipped, failed} 并入队；入队不改库；Worker 终态再写 success/failed/skipped。
 * jobId: map-regeo:{userId}:{mediaId}
 * @param {number} [limitPerBatch=500] - 单批处理上限。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<number>} 实际入队数量。
 */
async function enqueueMapRegeoRebuildAll(limitPerBatch = 500, userId) {
  return enqueueRebuildAllByCursor({
    limitPerBatch,
    userId,
    selectBatch: selectPendingMapRegeoBatch,
    buildJob: _buildMapRegeoJob,
    addBulk: (jobs) => mapRegeoQueue.addBulk(jobs),
    countPending: countMapRegeoSkippedForUser,
    logLabel: 'enqueueMapRegeoRebuildAll',
    maxIterEnvKey: 'MAP_REGEO_REBUILD_MAX_ITERATIONS',
    logger
  })
}

/** mapRegeoIngestor：仅通过本服务访问下列 model 方法 */
/**
 * 查询 mapRegeo 任务需要的媒体行。
 * @param {number|string} mediaId - 媒体 ID。
 * @param {number|string} userId - 用户 ID。
 * @returns {object|null} 媒体行或 null。
 */
function selectMediaRowForMapRegeoJob(mediaId, userId) {
  return mediaModel.selectMediaRowForMapRegeoJob(mediaId, userId)
}

/**
 * 更新媒体地点信息。
 * @param {number|string} mediaId - 媒体 ID。
 * @param {object} locationPayload - 地点信息载荷。
 * @param {object} options - 更新选项。
 * @returns {any} model 更新结果。
 */
function updateLocationInfo(mediaId, locationPayload, options) {
  return mediaModel.updateLocationInfo(mediaId, locationPayload, options)
}

/**
 * 更新媒体 map_regeo 状态。
 * @param {number|string} mediaId - 媒体 ID。
 * @param {string} status - 状态值。
 * @returns {any} model 更新结果。
 */
function updateMapRegeoStatus(mediaId, status) {
  return mediaModel.updateMapRegeoStatus(mediaId, status)
}

module.exports = {
  getMapRegeoSkippedCount,
  enqueueMapRegeoRebuildAll,
  selectMediaRowForMapRegeoJob,
  updateLocationInfo,
  updateMapRegeoStatus
}
