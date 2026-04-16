/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:45:00
 * @Description: File description
 */
const mediaService = require('../services/mediaService')
const similarService = require('../services/similarService')
const appSettingsService = require('../services/appSettingsService')
const CustomError = require('../errors/customError')
const { ERROR_CODES, SUCCESS_CODES } = require('../constants/messageCodes')
const { getRedisClient } = require('../services/redisClient')
const { userSetKey } = require('../workers/userMediaHashset')
const { updateProgress } = require('../services/mediaProcessingProgressService')
const logger = require('../utils/logger')
const {
  getMediaDownloadInfo,
  selectMediaRowByHashForUser,
  listFailedMedias,
  listAllFailedCloudMedias,
  countFailedMediasByStage
} = mediaService
const trashService = require('../services/trashService')
const { mediaAnalysisQueue } = require('../queues/mediaAnalysisQueue')
const { mediaMetaQueue } = require('../queues/mediaMetaQueue')
const { cloudCaptionQueue } = require('../queues/cloudCaptionQueue')
const { getRowByKeyType, KEY_TYPE_CLOUD_MODEL } = appSettingsService

const CLOUD_RETRY_JOB_IN_FLIGHT_STATES = new Set(['waiting', 'active', 'delayed', 'paused'])
const CLOUD_RETRY_LIST_MAX = Math.max(500, Math.min(Number(process.env.CLOUD_RETRY_LIST_MAX) || 20000, 200000))
const CLOUD_RETRY_BATCH_SIZE = Math.max(50, Math.min(Number(process.env.CLOUD_RETRY_BATCH_SIZE) || 500, 2000))

/**
 * 处理中心「云阶段失败」重试：固定 jobId 避免连点重复入队。
 * removeOnFail 会保留失败 job，同 jobId 再次 add 只会走 duplicated 且不会重新进 wait，故非进行中状态会先 remove 再 add。
 * @returns {Promise<boolean>} true 表示新入队；false 表示已有同 jobId 在等待/执行中，跳过。
 */
async function enqueueCloudCaptionRetryJob(userId, mediaInfo) {
  const mediaId = mediaInfo.id
  const jobId = `retry-cloud:${userId}:${mediaId}`
  const existing = await cloudCaptionQueue.getJob(jobId)
  if (existing) {
    const st = await existing.getState()
    if (CLOUD_RETRY_JOB_IN_FLIGHT_STATES.has(st)) {
      return false
    }
    await existing.remove({ removeChildren: true })
  }
  await cloudCaptionQueue.add(
    'cloud-caption-retry',
    {
      mediaId: mediaInfo.id,
      userId,
      highResStorageKey: mediaInfo.highResStorageKey ?? null,
      originalStorageKey: mediaInfo.originalStorageKey ?? null,
      mediaType: mediaInfo.mediaType || 'image'
    },
    { jobId }
  )
  return true
}

// 分页获取模糊图列表（is_blurry = 1），用于清理页模糊图 tab
// GET /api/media/blurry?pageNo=1&pageSize=20
async function handleGetBlurryMedias(req, res, next) {
  try {
    const { userId } = req?.user
    const { pageNo, pageSize } = req.query
    const result = await mediaService.getBlurryMedias({
      userId,
      pageNo,
      pageSize
    })
    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

// 分页获取相似图分组列表（清理页相似图 tab）
// GET /api/media/similar?pageNo=1&pageSize=12
async function handleGetSimilarGroups(req, res, next) {
  try {
    const { userId } = req?.user
    const { pageNo, pageSize } = req.query
    const data = await similarService.getSimilarGroups({
      userId,
      pageNo: Number(pageNo) || 1,
      pageSize: Number(pageSize) || 12
    })
    res.sendResponse({ data })
  } catch (error) {
    next(error)
  }
}

/**
 * 预检文件是否存在 - 通用图片检查接口
 * POST /images/checkFileExists
 * Body: { hash }
 *
 * 以库内 (user_id, file_hash) 为准：
 * - 无行：清理 Redis 陈旧 hash，返回不存在
 * - 仅回收站有行：静默恢复后返回 exists:true（计 uploadedCount，不计「跳过」）
 * - 正常库内：秒传，计 existingFiles
 */
async function handleCheckFileExists(req, res, next) {
  try {
    const { hash, sessionId } = req.body
    const userId = req?.user?.userId

    if (!hash) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const redisClient = getRedisClient()
    const setKey = userSetKey(userId)
    const row = selectMediaRowByHashForUser({ userId, imageHash: hash })

    if (!row) {
      try {
        await redisClient.srem(setKey, hash)
      } catch {
        /* ignore */
      }
      return res.sendResponse({
        data: { exists: false },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED
      })
    }

    if (row.deleted_at != null) {
      await trashService.restoreMedias({ userId, imageIds: [row.id] })
      try {
        await redisClient.sadd(setKey, hash)
      } catch {
        /* ignore */
      }
      if (sessionId) {
        // 与正常入库后走 meta 流水线一致：基础处理进度 = ingestDoneCount/uploadedCount
        await updateProgress({ sessionId, status: 'uploadedCount' })
        await updateProgress({ sessionId, status: 'ingestDoneCount' })
      }
      logger.info({
        message: 'checkFileExists: restored from trash on re-upload',
        details: { userId, imageHash: hash, mediaId: row.id }
      })
      return res.sendResponse({
        data: { exists: true, restoredFromTrash: true },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED
      })
    }

    logger.info({
      message: 'File exists check: found active media',
      details: { userId, imageHash: hash }
    })

    if (sessionId) {
      await updateProgress({
        sessionId,
        status: 'existingFiles'
      })
    }
    try {
      await redisClient.sadd(setKey, hash)
    } catch {
      /* ignore */
    }

    return res.sendResponse({
      data: { exists: true },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED
    })
  } catch (error) {
    next(error)
  }
}

// 部分更新图片信息（仅用于 favorite 字段）
async function handlePatchMedia(req, res, next) {
  try {
    const { userId } = req?.user
    const { mediaId } = req.params
    const patchData = req.body // { favorite: true }

    if (!mediaId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const result = await mediaService.patchMedia({ userId, imageId: parseInt(mediaId), patchData })

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

// 批量删除图片（软删除，移至回收站）
async function handleDeleteMedias(req, res, next) {
  try {
    const { userId } = req?.user
    const { mediaIds, groupId } = req.body || {}

    if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'warning'
      })
    }

    // 相似图删除：提供 groupId 时走 similarService（需刷新分组统计）；其余（含模糊图、首页等）走 imageService 通用删除
    let result
    if (groupId) {
      result = await similarService.deleteMedias({
        userId,
        groupId,
        imageIds: mediaIds
      })
    } else {
      result = await mediaService.deleteMedias({
        userId,
        imageIds: mediaIds
      })
    }

    res.sendResponse({ data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * 各阶段处理失败数量汇总
 * GET /api/media/processing-failures/summary
 */
async function handleGetProcessingFailureSummary(req, res, next) {
  try {
    const userId = req?.user?.userId
    const cloudRow = getRowByKeyType(userId, KEY_TYPE_CLOUD_MODEL)
    const cloudModelReady = Number(cloudRow?.enabled) === 1 && Boolean(cloudRow?.api_key && String(cloudRow.api_key).trim() !== '')
    const data = countFailedMediasByStage(userId, { includeCloudFailures: cloudModelReady })
    res.sendResponse({
      data
    })
  } catch (error) {
    next(error)
  }
}

/**
 * 重试处理失败媒体
 * POST /api/media/processing-failures/retry?stage=primary
 * body: { mediaIds?: number[] }
 */
async function handleRetryProcessingFailures(req, res, next) {
  try {
    const userId = req?.user?.userId
    const stage = req.query.stage || null // null / 'all' → 所有阶段
    const bodyMediaIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : null

    const validStages = ['primary', 'ingest', 'cloud']
    let stagesToRetry = stage === null || stage === 'all' ? validStages : validStages.includes(stage) ? [stage] : []

    if (stagesToRetry.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const cloudRow = getRowByKeyType(userId, KEY_TYPE_CLOUD_MODEL)
    const cloudModelReady = Number(cloudRow?.enabled) === 1 && Boolean(cloudRow?.api_key && String(cloudRow.api_key).trim() !== '')

    if (!cloudModelReady && stage === 'cloud') {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.UNSUPPORTED_OPERATION,
        messageType: 'error',
        message: '云模型未启用或未配置 API Key，无法重试云端分析阶段。'
      })
    }

    if (!cloudModelReady) {
      stagesToRetry = stagesToRetry.filter((s) => s !== 'cloud')
    }

    if (stagesToRetry.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    const nonCloudFailed = []

    for (const s of stagesToRetry) {
      if (s === 'cloud') {
        continue
      }
      const items = listFailedMedias({
        userId,
        stage: s,
        mediaIds: bodyMediaIds || null,
        limit: 500,
        offset: 0
      })
      for (const it of items) {
        nonCloudFailed.push({ ...it, stage: s })
      }
    }

    let cloudFailedRows = []
    if (stagesToRetry.includes('cloud')) {
      cloudFailedRows = listAllFailedCloudMedias({
        userId,
        mediaIds: bodyMediaIds,
        maxRows: CLOUD_RETRY_LIST_MAX
      })
    }

    const totalTargets = nonCloudFailed.length + cloudFailedRows.length
    if (totalTargets === 0) {
      return res.sendResponse({
        data: { stage: stage || 'all', retriedCount: 0, skippedCount: 0, mediaIds: [] }
      })
    }

    let retriedCount = 0
    const retriedMediaIds = []

    for (const media of nonCloudFailed) {
      const mediaId = media.mediaId

      if (media.stage === 'primary') {
        const mediaInfo = await getMediaDownloadInfo({ userId, imageId: mediaId })
        if (!mediaInfo) continue

        // 带时间戳：与主链路 analysis: 前缀不同；失败任务在 removeOnFail 下仍占 jobId 时仍可再次重试
        const jobId = `retry-primary:${userId}:${mediaId}:${Date.now()}`
        await mediaAnalysisQueue.add(
          'media-analysis',
          {
            imageId: mediaInfo.id,
            userId,
            highResStorageKey: mediaInfo.highResStorageKey || null,
            originalStorageKey: mediaInfo.originalStorageKey || null,
            mediaType: mediaInfo.mediaType || 'image',
            fileName: ''
          },
          { jobId }
        )
      } else if (media.stage === 'ingest') {
        // 基础处理重试：基于 original_storage_key 重新入队 meta 阶段
        if (!media.originalStorageKey) {
          continue
        }

        await mediaMetaQueue.add(
          process.env.MEDIA_META_QUEUE_NAME || 'media-meta',
          {
            userId,
            imageHash: media.imageHash,
            fileName: '',
            originalStorageKey: media.originalStorageKey,
            mediaType: media.mediaType || 'image',
            extension: process.env.MEDIA_HIGHRES_EXTENSION || 'avif',
            fileSize: media.fileSize,
            sessionId: null
          },
          {
            jobId: `retry-ingest:${userId}:${mediaId}:${Date.now()}`
          }
        )
      }

      retriedMediaIds.push(String(mediaId))
      retriedCount += 1
    }

    for (let i = 0; i < cloudFailedRows.length; i += CLOUD_RETRY_BATCH_SIZE) {
      const batch = cloudFailedRows.slice(i, i + CLOUD_RETRY_BATCH_SIZE)
      for (const row of batch) {
        const mediaId = row.mediaId
        const mediaInfo = await getMediaDownloadInfo({ userId, imageId: mediaId })
        if (!mediaInfo) continue

        const enqueued = await enqueueCloudCaptionRetryJob(userId, mediaInfo)
        if (!enqueued) continue

        retriedMediaIds.push(String(mediaId))
        retriedCount += 1
      }
    }

    res.sendResponse({
      data: {
        stage: stage || 'all',
        retriedCount,
        skippedCount: totalTargets - retriedCount,
        mediaIds: retriedMediaIds
      }
    })
  } catch (error) {
    next(error)
  }
}

module.exports = {
  handleGetBlurryMedias,
  handleGetSimilarGroups,
  handleCheckFileExists,
  handlePatchMedia,
  handleDeleteMedias,
  handleGetProcessingFailureSummary,
  handleRetryProcessingFailures
}
