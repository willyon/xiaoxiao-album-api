/*
 * @Author: zhangshouchang
 * @Date: 2025-08-31
 * @Description: meta 阶段（EXIF + 高清产物 + DB 补充）的独立处理器
 */

const logger = require('../utils/logger')
const { saveProcessedMediaMetadata } = require('../services/mediaService')
const { timestampToYearMonth, timestampToYear, timestampToDate, timestampToDayOfWeek } = require('../utils/formatTime')
const storageService = require('../services/storageService')
const videoProcessingService = require('../services/videoProcessingService')
const { updateProgress, updateProgressOnce } = require('../services/mediaProcessingProgressService')
const { mediaAnalysisQueue } = require('../queues/mediaAnalysisQueue')
const { QUEUE_JOB_ATTEMPTS } = require('../config/queueConfig')
const { bullMqWillRetryAfterThisFailure } = require('../utils/bullmq/queuePipelineLifecycle')
const mediaMetadataService = require('../services/mediaMetadataService')
const { addMediaToSession } = require('../services/uploadSessionService')
const { getVideoMimeTypeFromFileName } = require('../utils/fileUtils')

/**
 * 处理重试失败后的清理工作（用于imageMetaIngestor）
 * @param {Object} params - 参数对象
 * @param {Object} params.job - BullMQ job对象
 * @param {string} params.reason - 失败原因
 * @param {string} params.fileName - 文件名
 * @param {string} params.imageHash - 图片哈希
 * @param {string} params.userId - 用户ID
 * @param {string} [params.highResStorageKey] - 高清图存储键（可选）
 * @param {unknown} [params.err] - 本次失败错误（与 BullMQ 重试策略对齐，如 UnrecoverableError）
 * @returns {Promise<void>} 无返回值。
 */
async function _handleMetaRetryFailure({ job, err, reason, fileName, imageHash, userId, highResStorageKey }) {
  const maxAttempts = job?.opts?.attempts || QUEUE_JOB_ATTEMPTS
  const attemptsMade = job?.attemptsMade || 0
  const willRetry = bullMqWillRetryAfterThisFailure(job, err)

  if (!willRetry) {
    // 没有重试机会了，执行最终清理
    try {
      // 1. 如果有高清图，先删除
      if (highResStorageKey) {
        await storageService.storage.deleteFile(highResStorageKey)
      }

      logger.info({
        message: 'High-res image processing failed after all retries exhausted',
        details: {
          imageHash,
          userId,
          highResCleaned: highResStorageKey,
          reason,
          attemptsMade,
          maxAttempts
        }
      })
    } catch (cleanupError) {
      logger.warn({
        message: 'Failed to cleanup files after all retries exhausted',
        details: {
          highResStorageKey,
          cleanupError: cleanupError.message,
          fallbackAction: 'manual_cleanup_required'
        }
      })
    }

    // 更新处理进度（基础处理最终失败；同图同会话只计一次，与 aiErrorCount 一致）
    if (job.data.sessionId && imageHash) {
      await updateProgressOnce({
        sessionId: job.data.sessionId,
        status: 'ingestErrorCount',
        dedupeKey: imageHash
      })
    }
  } else {
    // 还有重试机会，只清理已生成的高清图，保留源文件
    let highResCleaned = false

    if (highResStorageKey) {
      try {
        await storageService.storage.deleteFile(highResStorageKey)
        highResCleaned = true
      } catch (cleanupError) {
        logger.warn({
          message: 'Failed to cleanup highRes file before retry',
          details: {
            highResStorageKey,
            cleanupError: cleanupError.message
          }
        })
      }
    }

    logger.info({
      message: `${reason}, will retry${highResCleaned ? ' - highRes cleaned' : ''}`,
      details: {
        imageHash,
        userId,
        fileName,
        highResCleaned,
        attemptsMade,
        maxAttempts,
        nextAttempt: attemptsMade + 1
      }
    })
  }
}

/**
 * 处理视频的 meta 阶段：ffprobe 元数据、移动原片、入队 AI 阶段
 * @param {Object} job - BullMQ job 对象。
 * @param {{userId:number|string,imageHash:string,fileName:string,originalStorageKey:string,sessionId?:string}} params - 视频处理参数。
 * @returns {Promise<void>} 无返回值。
 */
async function processVideoMeta(job, { userId, imageHash, fileName, originalStorageKey, sessionId }) {
  let videoPath
  try {
    videoPath = await storageService.storage.getFileData(originalStorageKey)
  } catch (err) {
    await _handleMetaRetryFailure({ job, err, reason: 'file_read_failed', fileName, imageHash, userId })
    throw err
  }

  let meta
  try {
    meta = await videoProcessingService.getVideoMetadata(videoPath)
  } catch (err) {
    await _handleMetaRetryFailure({ job, err, reason: 'metadata_analysis_failed', fileName, imageHash, userId })
    throw err
  }

  const captureTime = meta.creationTime || undefined
  const monthKey = timestampToYearMonth(captureTime)
  const yearKey = timestampToYear(captureTime)
  const dateKey = timestampToDate(captureTime)
  const dayKey = timestampToDayOfWeek(captureTime)

  let gpsLocation = null
  let country = null
  let province = null
  let city = null
  let mapRegeoStatus
  if (meta.gpsLatitude != null && meta.gpsLongitude != null) {
    try {
      const locInfo = await mediaMetadataService.analyzeLocationInfo(meta.gpsLatitude, meta.gpsLongitude, userId)
      gpsLocation = locInfo?.gpsLocation || null
      country = locInfo?.country || null
      province = locInfo?.province || null
      city = locInfo?.city || null
      mapRegeoStatus = locInfo?.mapRegeoStatus
    } catch (e) {
      logger.warn({ message: 'Video GPS reverse geocode failed', details: { imageHash, error: e.message } })
    }
  }

  // 视频：width/height 已为 ffprobe 按 rotation 换算后的「观感」尺寸；layout_type / aspect_ratio 与图片同源（calculateOrientationInfo，orientation=1 表示不再按 EXIF 交换）
  // raw_orientation 仅用于图片 EXIF 1–8，视频不传，库中保持 NULL（旋转信息已体现在宽高中）
  const videoOrientationInfo = mediaMetadataService.calculateOrientationInfo(meta.width, meta.height, 1)
  const aspectRatio = videoOrientationInfo.aspectRatio
  const layoutType = videoOrientationInfo.layoutType
  const mime = getVideoMimeTypeFromFileName(fileName) || 'application/octet-stream'
  const durationSec = typeof meta.duration === 'number' ? Math.round(meta.duration) : null

  let mediaId = null
  try {
    const result = await saveProcessedMediaMetadata({
      userId,
      imageHash,
      creationDate: captureTime,
      monthKey,
      yearKey,
      dateKey,
      dayKey,
      highResStorageKey: null,
      originalStorageKey,
      gpsLatitude: meta.gpsLatitude,
      gpsLongitude: meta.gpsLongitude,
      gpsLocation,
      country,
      province,
      city,
      widthPx: meta.width,
      heightPx: meta.height,
      aspectRatio,
      layoutType,
      // 不传 rawOrientation → updateMediaMetadata 中 COALESCE 不覆盖，新建行保持 raw_orientation 为 NULL
      mime,
      durationSec,
      videoCodec: meta.codec,
      mediaType: 'video',
      mapRegeoStatus: meta.gpsLatitude != null && meta.gpsLongitude != null ? mapRegeoStatus : undefined
    })
    mediaId = result.mediaId
  } catch (e) {
    logger.error({
      message: 'Video metadata database update failed',
      details: { imageHash, userId, err: e.message }
    })
    await _handleMetaRetryFailure({
      job,
      err: e,
      reason: 'database_update_failed',
      fileName,
      imageHash,
      userId
    })
    throw e
  }

  if (sessionId && mediaId) {
    try {
      await addMediaToSession({ sessionId, mediaId: mediaId })
    } catch {}
  }

  await _enqueueAiAndCleanup({
    mediaId,
    userId,
    highResStorageKey: null,
    originalStorageKey,
    sessionId,
    mediaType: 'video',
    fileName,
    imageHash
  })

  // 将 media 完成计数后移到 AI 入队之后，避免单图场景出现 completed 的短暂竞态窗口
  if (sessionId) {
    try {
      await updateProgress({ sessionId, status: 'ingestDoneCount' })
    } catch {}
  }
}

/**
 * 入队 AI 分析并更新会话可分析计数。
 * @param {{mediaId:number,userId:number|string,highResStorageKey:string|null,originalStorageKey:string,sessionId?:string,mediaType?:'image'|'video',fileName?:string,imageHash:string}} params - 入队参数。
 * @returns {Promise<void>} 无返回值。
 */
async function _enqueueAiAndCleanup({ mediaId, userId, highResStorageKey, originalStorageKey, sessionId, mediaType, fileName, imageHash }) {
  if (!mediaId) {
    logger.warn({
      message: 'Cannot add to queues - mediaId is null',
      details: { imageHash, userId }
    })
    return
  }

  try {
    await mediaAnalysisQueue.add(
      'media-analysis',
      {
        mediaId,
        userId,
        highResStorageKey,
        originalStorageKey,
        sessionId,
        mediaType: mediaType || 'image',
        fileName: fileName || ''
      },
      { jobId: `analysis:${userId}:${mediaId}` }
    )
    if (sessionId) {
      await updateProgressOnce({
        sessionId,
        status: 'aiEligibleCount',
        dedupeKey: mediaId
      })
    }
  } catch (err) {
    logger.warn({
      message: 'Failed to add media to mediaAnalysisQueue',
      details: { imageHash, userId, error: err.message }
    })
  }
}

/**
 * 处理单张图片的"后处理"：
 * 1) 读取 EXIF → creationDate/monthKey/yearKey
 * 2) 产出高清大图（默认 AVIF）
 * 3) 更新数据库（补 creationDate/monthKey/yearKey/highResStorageKey）
 * 4) 将原图移动至 original 存储位置
 *
 * @param {Object} job - BullMQ job对象
 * @returns {Promise<void>} 无返回值。
 */
async function processMediaMeta(job) {
  const { userId, imageHash, fileName, originalStorageKey, extension, fileSize, sessionId, mediaType = 'image' } = job.data

  // ========== 视频分支：ffprobe 元数据，不生成 highres；会入队 AI worker 做 analysis 完成态收敛 ==========
  if (mediaType === 'video') {
    return processVideoMeta(job, {
      userId,
      imageHash,
      fileName,
      originalStorageKey,
      sessionId
    })
  }

  // ========== 图片分支：沿用现有逻辑 ==========
  const highResType = process.env.MEDIA_STORAGE_KEY_HIGHRES || 'highres'
  let highResStorageKeyResult = null
  let hdWidthPx = null
  let hdHeightPx = null

  let fileData = null
  try {
    fileData = await storageService.storage.getFileData(originalStorageKey)
  } catch (err) {
    await _handleMetaRetryFailure({ job, err, reason: 'file_read_failed', fileName, imageHash, userId })
    throw err
  }

  let metadata = null
  try {
    metadata = await mediaMetadataService.analyzeMediaMetadata(fileData, {
      includeLocation: true,
      userId
    })
  } catch (err) {
    await _handleMetaRetryFailure({ job, err, reason: 'metadata_analysis_failed', fileName, imageHash, userId })
    throw err
  }

  const {
    captureTime,
    latitude,
    longitude,
    altitude,
    gpsLocation,
    country,
    province,
    city,
    width,
    height,
    aspectRatio,
    orientation,
    layoutType,
    mime,
    mapRegeoStatus
  } = metadata

  const monthKey = timestampToYearMonth(captureTime)
  const yearKey = timestampToYear(captureTime)
  const dateKey = timestampToDate(captureTime)
  const dayKey = timestampToDayOfWeek(captureTime)

  const highResStorageKey = storageService.storage.generateStorageKey(highResType, fileName, extension)

  try {
    const hdResult = await storageService.processAndStoreImage({
      fileSize,
      sourceStorageKey: originalStorageKey,
      targetStorageKey: highResStorageKey,
      extension,
      quality: 65,
      resizeWidth: 2048
    })

    highResStorageKeyResult = highResStorageKey
    hdWidthPx = hdResult.width
    hdHeightPx = hdResult.height
  } catch (e) {
    logger.error({
      message: 'Generate HQ image failed',
      details: { imageHash, userId, highResStorageKey, err: String(e) }
    })

    await _handleMetaRetryFailure({
      job,
      err: e,
      reason: 'highres_generation_failed',
      fileName,
      imageHash,
      userId,
      highResStorageKey: highResStorageKeyResult
    })

    throw e
  }

  let mediaId = null
  try {
    const result = await saveProcessedMediaMetadata({
      userId,
      imageHash,
      creationDate: captureTime,
      monthKey,
      yearKey,
      dateKey,
      dayKey,
      highResStorageKey: highResStorageKeyResult,
      originalStorageKey,
      gpsLatitude: latitude,
      gpsLongitude: longitude,
      gpsAltitude: altitude,
      gpsLocation,
      country,
      province,
      city,
      widthPx: width,
      heightPx: height,
      aspectRatio,
      rawOrientation: orientation,
      layoutType,
      hdWidthPx,
      hdHeightPx,
      mime,
      mapRegeoStatus: latitude != null && longitude != null ? mapRegeoStatus : undefined
    })
    mediaId = result.mediaId
  } catch (e) {
    // 数据库更新失败
    logger.error({
      message: 'Database update failed - EXIF metadata and high-res image info could not be saved',
      details: { imageHash, userId, err: String(e) }
    })

    // 处理重试失败逻辑
    await _handleMetaRetryFailure({
      job,
      err: e,
      reason: 'database_update_failed',
      fileName,
      imageHash,
      userId,
      highResStorageKey: highResStorageKeyResult // 数据库更新失败时，需要清理已生成的高清图
    })

    throw e
  }
  // ======== 移动原图到 original 存储位置 ========
  if (sessionId && mediaId) {
    try {
      await addMediaToSession({ sessionId, mediaId: mediaId })
    } catch {}
  }

  await _enqueueAiAndCleanup({
    mediaId,
    userId,
    highResStorageKey: highResStorageKeyResult,
    originalStorageKey,
    sessionId,
    mediaType: 'image',
    fileName,
    imageHash
  })

  // 将 media 完成计数后移到 AI 入队之后，避免单图场景出现 completed 的短暂竞态窗口
  try {
    if (sessionId) {
      await updateProgress({
        sessionId,
        status: 'ingestDoneCount'
      })
    }
  } catch {}
}

module.exports = {
  processMediaMeta
}
