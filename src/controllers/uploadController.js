/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:01:24
 * @Description: File description
 */
const CustomError = require('../errors/customError')
const { SUCCESS_CODES, ERROR_CODES } = require('../constants/messageCodes')
const { computeFileHash } = require('../utils/hash')
const { getMediaTypeFromFile } = require('../utils/fileUtils')
const storageService = require('../services/storageService')
const { enqueueMediaUploadIfNeeded } = require('../services/mediaUploadEnqueueService')
const logger = require('../utils/logger')
const asyncHandler = require('../utils/asyncHandler')

/**
 * 处理单文件上传并投递后续处理任务。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
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

  const sessionId = req.body.sessionId
  const dedupeCheck = await enqueueMediaUploadIfNeeded({
    userId,
    imageHash,
    fileName,
    fileSize,
    storageKey: file.path || '',
    sessionId,
    mediaType,
    duplicateAction: 'duplicate_skipped_before_storage',
    duplicateDetails: { source: 'uploadController' },
    checkOnly: true
  })
  if (dedupeCheck.duplicate) {
    if (file.path) {
      await storageService.deleteFile({ fileName, storageKey: file.path })
    }
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

  const enqueueResult = await enqueueMediaUploadIfNeeded({
    userId,
    imageHash,
    fileName,
    fileSize,
    storageKey,
    sessionId,
    mediaType,
    duplicateAction: 'duplicate_skipped_after_storage',
    duplicateNote: 'file already stored before queue check',
    duplicateDetails: { source: 'uploadController' }
  })
  if (enqueueResult.duplicate) {
    await storageService.deleteFile({ fileName, storageKey })
  }

  res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY })
}

module.exports = {
  handlePostMedias: asyncHandler(handlePostMedias)
}
