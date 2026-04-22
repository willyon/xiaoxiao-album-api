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
const asyncHandler = require('../utils/asyncHandler')
const { parsePagination, parsePositiveIntParam } = require('../utils/requestParams')
const {
  getMediaExportInfo,
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
const VALID_RETRY_STAGES = ['primary', 'ingest', 'cloud']

/**
 * 处理中心「云阶段失败」重试：固定 jobId 避免连点重复入队。
 * removeOnFail 会保留失败 job，同 jobId 再次 add 只会走 duplicated 且不会重新进 wait，故非进行中状态会先 remove 再 add。
 * @param {number|string} userId - 用户 ID。
 * @param {{id:number,highResStorageKey?:string|null,originalStorageKey?:string|null,mediaType?:string}} mediaInfo - 媒体信息。
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
/**
 * 获取当前用户的模糊图分页列表。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetBlurryMedias(req, res) {
  const { userId } = req?.user
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 20 })
  const result = await mediaService.getBlurryMedias({
    userId,
    pageNo,
    pageSize
  })
  res.sendResponse({ data: result })
}

// 分页获取相似图分组列表（清理页相似图 tab）
// GET /api/media/similar?pageNo=1&pageSize=12
/**
 * 获取当前用户的相似图分组分页列表。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetSimilarGroups(req, res) {
  const { userId } = req?.user
  const { pageNo, pageSize } = parsePagination(req.query, { pageNo: 1, pageSize: 12 })
  const data = await similarService.getSimilarGroups({
    userId,
    pageNo,
    pageSize
  })
  res.sendResponse({ data })
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
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleCheckFileExists(req, res) {
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
    await trashService.restoreMedias({ userId, mediaIds: [row.id] })
    try {
      await redisClient.sadd(setKey, hash)
    } catch {
      /* ignore */
    }
    if (sessionId) {
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
}

// 部分更新图片信息（仅用于 favorite 字段）
/**
 * 更新单个媒体的部分字段。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handlePatchMedia(req, res) {
  const { userId } = req?.user
  const mediaId = parsePositiveIntParam(req.params.mediaId)
  const patchData = req.body // { favorite: true }

  const result = await mediaService.patchMedia({ userId, mediaId, patchData })

  res.sendResponse({ data: result })
}

// 批量删除图片（软删除，移至回收站）
/**
 * 批量软删除媒体到回收站。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleDeleteMedias(req, res) {
  const { userId } = req?.user
  const { mediaIds, groupId } = req.body || {}

  if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
    throwInvalidParametersError('warning')
  }

  let result
  if (groupId) {
      result = await similarService.deleteMedias({
        userId,
        groupId,
        mediaIds
      })
    } else {
      result = await mediaService.deleteMedias({
        userId,
        mediaIds
      })
  }

  res.sendResponse({ data: result })
}

/**
 * 各阶段处理失败数量汇总
 * GET /api/media/processing-failures/summary
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetProcessingFailureSummary(req, res) {
  const userId = req?.user?.userId
  const cloudRow = getRowByKeyType(userId, KEY_TYPE_CLOUD_MODEL)
  const cloudModelReady = Number(cloudRow?.enabled) === 1 && Boolean(cloudRow?.api_key && String(cloudRow.api_key).trim() !== '')
  const data = countFailedMediasByStage(userId, { includeCloudFailures: cloudModelReady })
  res.sendResponse({
    data
  })
}

/**
 * 重试处理失败媒体
 * POST /api/media/processing-failures/retry?stage=primary
 * body: { mediaIds?: number[] }
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleRetryProcessingFailures(req, res) {
  const userId = req?.user?.userId
  const stage = req.query.stage || null // null / 'all' → 所有阶段
  const bodyMediaIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : null

  const stagesToRetry = resolveRetryStages({ userId, stage })
  const { nonCloudFailed, cloudFailedRows } = collectRetryTargets({ userId, stagesToRetry, bodyMediaIds })
  const totalTargets = nonCloudFailed.length + cloudFailedRows.length
  if (totalTargets === 0) {
    return res.sendResponse({
      data: { stage: stage || 'all', retriedCount: 0, skippedCount: 0, mediaIds: [] }
    })
  }

  const nonCloudResult = await retryNonCloudFailures({ userId, rows: nonCloudFailed })
  const cloudResult = await retryCloudFailures({ userId, rows: cloudFailedRows })
  const retriedMediaIds = [...nonCloudResult.mediaIds, ...cloudResult.mediaIds]
  const retriedCount = nonCloudResult.count + cloudResult.count

  res.sendResponse({
    data: {
      stage: stage || 'all',
      retriedCount,
      skippedCount: totalTargets - retriedCount,
      mediaIds: retriedMediaIds
    }
  })
}

function resolveRetryStages({ userId, stage }) {
  let stages = stage == null || stage === 'all' ? [...VALID_RETRY_STAGES] : VALID_RETRY_STAGES.includes(stage) ? [stage] : []
  if (stages.length === 0) {
    throwInvalidParametersError('error')
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
  if (!cloudModelReady) stages = stages.filter((s) => s !== 'cloud')
  if (stages.length === 0) {
    throwInvalidParametersError('error')
  }
  return stages
}

function throwInvalidParametersError(messageType = 'error') {
  throw new CustomError({
    httpStatus: 400,
    messageCode: ERROR_CODES.INVALID_PARAMETERS,
    messageType
  })
}

function collectRetryTargets({ userId, stagesToRetry, bodyMediaIds }) {
  const nonCloudFailed = []
  for (const s of stagesToRetry) {
    if (s === 'cloud') continue
    const items = listFailedMedias({
      userId,
      stage: s,
      mediaIds: bodyMediaIds || null,
      limit: 500,
      offset: 0
    })
    for (const it of items) nonCloudFailed.push({ ...it, stage: s })
  }
  const cloudFailedRows = stagesToRetry.includes('cloud')
    ? listAllFailedCloudMedias({ userId, mediaIds: bodyMediaIds, maxRows: CLOUD_RETRY_LIST_MAX })
    : []
  return { nonCloudFailed, cloudFailedRows }
}

async function retryNonCloudFailures({ userId, rows }) {
  const mediaIds = []
  let count = 0
  for (const media of rows) {
    const retried = media.stage === 'primary'
      ? await retryPrimaryFailure({ userId, media })
      : await retryIngestFailure({ userId, media })
    if (!retried) continue
    mediaIds.push(String(media.mediaId))
    count += 1
  }
  return { mediaIds, count }
}

async function retryPrimaryFailure({ userId, media }) {
  const mediaInfo = await getMediaExportInfo({ userId, mediaId: media.mediaId })
  if (!mediaInfo) return false
  await mediaAnalysisQueue.add(
    'media-analysis',
    {
      mediaId: mediaInfo.id,
      userId,
      highResStorageKey: mediaInfo.highResStorageKey || null,
      originalStorageKey: mediaInfo.originalStorageKey || null,
      mediaType: mediaInfo.mediaType || 'image',
      fileName: ''
    },
    { jobId: `retry-primary:${userId}:${media.mediaId}:${Date.now()}` }
  )
  return true
}

async function retryIngestFailure({ userId, media }) {
  if (!media.originalStorageKey) return false
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
    { jobId: `retry-ingest:${userId}:${media.mediaId}:${Date.now()}` }
  )
  return true
}

async function retryCloudFailures({ userId, rows }) {
  const mediaIds = []
  let count = 0
  for (let i = 0; i < rows.length; i += CLOUD_RETRY_BATCH_SIZE) {
    const batch = rows.slice(i, i + CLOUD_RETRY_BATCH_SIZE)
    for (const row of batch) {
      const mediaInfo = await getMediaExportInfo({ userId, mediaId: row.mediaId })
      if (!mediaInfo) continue
      const enqueued = await enqueueCloudCaptionRetryJob(userId, mediaInfo)
      if (!enqueued) continue
      mediaIds.push(String(row.mediaId))
      count += 1
    }
  }
  return { mediaIds, count }
}

module.exports = {
  handleGetBlurryMedias: asyncHandler(handleGetBlurryMedias),
  handleGetSimilarGroups: asyncHandler(handleGetSimilarGroups),
  handleCheckFileExists: asyncHandler(handleCheckFileExists),
  handlePatchMedia: asyncHandler(handlePatchMedia),
  handleDeleteMedias: asyncHandler(handleDeleteMedias),
  handleGetProcessingFailureSummary: asyncHandler(handleGetProcessingFailureSummary),
  handleRetryProcessingFailures: asyncHandler(handleRetryProcessingFailures)
}
