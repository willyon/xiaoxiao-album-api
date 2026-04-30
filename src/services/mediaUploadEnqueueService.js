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
  const existingJob = await mediaUploadQueue.getJob(jobId)
  if (existingJob) {
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
  } catch (error) {
    throw error
  }

  try {
    await updateProgress({
      sessionId,
      status: 'uploadedCount'
    })
  } catch (error) {
  }
  return { enqueued: true, jobId, duplicate: false }
}

module.exports = {
  enqueueMediaUploadIfNeeded
}
