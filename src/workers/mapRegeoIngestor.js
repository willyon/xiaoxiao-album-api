const { UnrecoverableError } = require('bullmq')
const logger = require('../utils/logger')
const { bullMqWillRetryAfterThisFailure } = require('../utils/bullmq/queuePipelineLifecycle')
const { getLocationFromCoordinates } = require('../services/geocodingService')
const { selectMediaRowForMapRegeoJob, updateLocationInfo, updateMapRegeoStatus } = require('../services/mapRegeoService')

/**
 * @param {import("bullmq").Job} job
 * @returns {Promise<void>} 无返回值。
 */
async function processMapRegeoJob(job) {
  const { mediaId, userId, latitude, longitude } = job.data || {}
  if (!mediaId || !userId) {
    logger.warn({ message: 'mapRegeoIngestor: missing mediaId/userId', details: { jobId: job.id, data: job.data } })
    return
  }

  const row = selectMediaRowForMapRegeoJob(mediaId, userId)
  if (!row) {
    throw new UnrecoverableError('MAP_REGEO_MEDIA_NOT_FOUND')
  }
  if (row.map_regeo_status !== 'skipped' && row.map_regeo_status !== 'failed') {
    return
  }

  const lat = latitude != null ? Number(latitude) : row.gps_latitude
  const lng = longitude != null ? Number(longitude) : row.gps_longitude
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new UnrecoverableError('MAP_REGEO_NO_GPS')
  }

  try {
    const { location, mapRegeoStatus } = await getLocationFromCoordinates(lat, lng, userId)
    if (mapRegeoStatus == null) {
      throw new Error('MAP_REGEO_NO_STATUS')
    }

    updateLocationInfo(
      mediaId,
      {
        gpsLocation: location?.formattedAddress ?? null,
        country: location?.country ?? null,
        province: location?.province ?? null,
        city: location?.city ?? null,
        mapRegeoStatus
      },
      { rebuildSearchArtifacts: true }
    )

    logger.info({
      message: 'mapRegeoIngestor.completed',
      details: { mediaId, userId, mapRegeoStatus }
    })
  } catch (error) {
    const willRetry = bullMqWillRetryAfterThisFailure(job, error)
    if (!willRetry) {
      updateMapRegeoStatus(mediaId, 'failed')
    }
    logger.error({
      message: 'mapRegeoIngestor.error',
      details: { mediaId, userId, error: error?.message, willRetry }
    })
    throw error
  }
}

module.exports = {
  processMapRegeoJob
}
