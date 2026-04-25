const { mediaUploadQueue } = require('../queues/mediaUploadQueue')
const { updateProgress } = require('./mediaProcessingProgressService')
const logger = require('../utils/logger')

/**
 * 入队前进行去重检查并更新上传会话进度。
 * @param {{
 * userId:number|string,
 * imageHash:string,
 * fileName:string,
 * fileSize:number,
 * storageKey:string,
 * sessionId?:string|null,
 * mediaType?:string,
 * duplicateAction:string,
 * duplicateNote?:string,
 * duplicateDetails?:Record<string, any>,
 * checkOnly?:boolean
 * }} payload - 入队参数。
 * @returns {Promise<{enqueued:boolean,jobId:string,duplicate:boolean}>} 是否已入队。
 */
async function enqueueMediaUploadIfNeeded(payload) {
  const {
    userId,
    imageHash,
    fileName,
    fileSize,
    storageKey,
    sessionId = null,
    mediaType,
    duplicateAction,
    duplicateNote,
    duplicateDetails = {},
    checkOnly = false
  } = payload

  const jobId = `${userId}:${imageHash}`
  logger.info({
    message: 'DEBUG_TMP_REMOVE.upload.enqueue.request_received',
    details: {
      jobId,
      userId,
      imageHash,
      fileName,
      fileSize,
      storageKey,
      sessionId,
      mediaType: mediaType || 'image',
      checkOnly
    }
  })
  const existingJob = await mediaUploadQueue.getJob(jobId)
  if (existingJob) {
    logger.info({
      message: 'DEBUG_TMP_REMOVE.upload.enqueue.duplicate_detected',
      details: {
        jobId,
        userId,
        imageHash,
        storageKey,
        fileName,
        action: duplicateAction,
        note: duplicateNote,
        ...duplicateDetails
      }
    })
    logger.info({
      message: 'Duplicate upload job detected, skipping queue processing',
      details: {
        jobId,
        userId,
        imageHash,
        storageKey,
        fileName,
        action: duplicateAction,
        note: duplicateNote,
        ...duplicateDetails
      }
    })
    await updateProgress({
      sessionId,
      status: 'duplicateCount'
    })
    return { enqueued: false, jobId, duplicate: true }
  }

  if (checkOnly) {
    logger.info({
      message: 'DEBUG_TMP_REMOVE.upload.enqueue.check_only_passed',
      details: { jobId, userId, imageHash, fileName, storageKey, sessionId }
    })
    return { enqueued: false, jobId, duplicate: false }
  }

  try {
    await mediaUploadQueue.add(
      process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload',
      {
        fileName,
        fileSize,
        storageKey,
        userId,
        imageHash,
        mediaType,
        extension: process.env.MEDIA_THUMBNAIL_EXTENSION || 'webp',
        sessionId
      },
      { jobId }
    )
    logger.info({
      message: 'DEBUG_TMP_REMOVE.upload.enqueue.queue_add_success',
      details: {
        queueName: process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload',
        jobId,
        userId,
        imageHash,
        fileName,
        storageKey,
        sessionId
      }
    })
  } catch (error) {
    logger.error({
      message: 'DEBUG_TMP_REMOVE.upload.enqueue.queue_add_failed',
      details: {
        queueName: process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload',
        jobId,
        userId,
        imageHash,
        fileName,
        storageKey,
        sessionId,
        error: error.message
      }
    })
    throw error
  }

  try {
    await updateProgress({
      sessionId,
      status: 'uploadedCount'
    })
    logger.info({
      message: 'DEBUG_TMP_REMOVE.upload.enqueue.progress_uploaded_count_updated',
      details: { sessionId, jobId, userId, imageHash }
    })
  } catch (error) {
    logger.warn({
      message: 'DEBUG_TMP_REMOVE.upload.enqueue.progress_uploaded_count_failed',
      details: { sessionId, jobId, userId, imageHash, error: error.message }
    })
  }
  return { enqueued: true, jobId, duplicate: false }
}

module.exports = {
  enqueueMediaUploadIfNeeded
}
