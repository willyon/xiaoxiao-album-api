const logger = require('../utils/logger')
const { mapRegeoQueue } = require('../queues/mapRegeoQueue')
const mediaModel = require('../models/mediaModel')
const { enqueueRebuildAllByCursor } = require('../utils/enqueueRebuildAllByCursor')

const { selectPendingMapRegeoBatch, countMapRegeoSkippedForUser } = mediaModel

/** 设置页展示：map_regeo_status 为 skipped 或 failed、且含 GPS 的条数 */
function getMapRegeoSkippedCount(userId) {
  return {
    skippedCount: countMapRegeoSkippedForUser(userId)
  }
}

/**
 * 按 id 游标分页查询 map_regeo_status ∈ {skipped, failed} 并入队；入队不改库；Worker 终态再写 success/failed/skipped。
 * jobId: map-regeo:{userId}:{mediaId}
 */
async function enqueueMapRegeoRebuildAll(limitPerBatch = 500, userId) {
  return enqueueRebuildAllByCursor({
    limitPerBatch,
    userId,
    selectBatch: selectPendingMapRegeoBatch,
    buildJob: (row) => {
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
    },
    addBulk: (jobs) => mapRegeoQueue.addBulk(jobs),
    countPending: countMapRegeoSkippedForUser,
    logLabel: 'enqueueMapRegeoRebuildAll',
    maxIterEnvKey: 'MAP_REGEO_REBUILD_MAX_ITERATIONS',
    logger
  })
}

/** mapRegeoIngestor：仅通过本服务访问下列 model 方法 */
function selectMediaRowForMapRegeoJob(mediaId, userId) {
  return mediaModel.selectMediaRowForMapRegeoJob(mediaId, userId)
}

function updateLocationInfo(imageId, locationPayload, options) {
  return mediaModel.updateLocationInfo(imageId, locationPayload, options)
}

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
