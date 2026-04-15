const logger = require('../utils/logger')
const { mapRegeoQueue } = require('../queues/mapRegeoQueue')
const { selectPendingMapRegeoBatch, countMapRegeoSkippedForUser } = require('../models/mediaModel')

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
  const envIter = Number(process.env.MAP_REGEO_REBUILD_MAX_ITERATIONS)
  const maxIter = Math.max(1, Math.min(Number.isFinite(envIter) && envIter > 0 ? envIter : 40, 100_000_000))
  let totalEnqueued = 0
  let cursorBeforeId = null

  for (let i = 0; i < maxIter; i++) {
    const rows = selectPendingMapRegeoBatch(limitPerBatch, userId, cursorBeforeId)
    if (!rows || rows.length === 0) {
      return totalEnqueued
    }

    const jobs = rows.map((row) => {
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
    })

    await mapRegeoQueue.addBulk(jobs)
    totalEnqueued += rows.length
    cursorBeforeId = rows[rows.length - 1].mediaId
  }

  const pendingLeft = countMapRegeoSkippedForUser(userId)
  logger.error({
    message: 'enqueueMapRegeoRebuildAll: iteration cap reached (check MAP_REGEO_REBUILD_MAX_ITERATIONS)',
    totalEnqueued,
    pendingLeft,
    maxIter,
    limitPerBatch
  })
  return totalEnqueued
}

module.exports = {
  getMapRegeoSkippedCount,
  enqueueMapRegeoRebuildAll
}
