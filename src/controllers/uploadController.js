/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:01:24
 * @Description: File description
 */
const CustomError = require('../errors/customError')
const { SUCCESS_CODES, ERROR_CODES } = require('../constants/messageCodes')
const { mediaUploadQueue } = require('../queues/mediaUploadQueue')
const { computeFileHash } = require('../utils/hash')
const { getMediaTypeFromFile } = require('../utils/fileUtils')
const storageService = require('../services/storageService')
const { updateProgress } = require('../services/mediaProcessingProgressService')
const logger = require('../utils/logger')
const asyncHandler = require('../utils/asyncHandler')

async function handlePostMedias(req, res) {
  const file = req.file //这里的file是multer中间件生成的上传文件对象
  if (!file) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.NO_UPLOAD_FILE,
      messageType: 'error'
    })
  }

  const { size: fileSize, filename: fileName } = file
  const userId = req?.user?.userId

  const mediaType = getMediaTypeFromFile(file)

  const imageHash = await computeFileHash(file.buffer || file.path)

  const jobId = `${userId}:${imageHash}`
  const existingJob = await mediaUploadQueue.getJob(jobId)

  if (existingJob) {
    logger.info({
      message: 'Duplicate job detected, skipping storage',
      details: {
        jobId,
        userId,
        imageHash,
        fileName,
        action: 'duplicate_skipped_before_storage'
      }
    })

    if (file.path) {
      await storageService.deleteFile({ fileName, storageKey: file.path })
    }

    await updateProgress({
      sessionId: req.body.sessionId,
      status: 'duplicateCount'
    })

    return res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY })
  }

  let storageKey
  if (file.buffer) {
    const uploadStorageKey = `upload/${fileName}`
    await storageService.storage.storeFile(file.buffer, uploadStorageKey)
    storageKey = uploadStorageKey

    logger.info({
      message: 'File uploaded to storage service',
      details: { userId, fileName, uploadStorageKey, fileSize }
    })
  } else {
    storageKey = file.path

    logger.info({
      message: 'File uploaded to local storage',
      details: { userId, fileName, path: file.path, fileSize }
    })
  }

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
      sessionId: req.body.sessionId
    },
    {
      jobId: jobId
    }
  )

  await updateProgress({
    sessionId: req.body.sessionId,
    status: 'uploadedCount'
  })

  res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY })
}

module.exports = {
  handlePostMedias: asyncHandler(handlePostMedias)
}
