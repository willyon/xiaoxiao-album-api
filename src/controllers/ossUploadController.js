/*
 * @Author: zhangshouchang
 * @Date: 2025-09-07 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-09-07 10:00:00
 * @Description: 预检和直传相关控制器
 */
const CustomError = require('../errors/customError')
const { SUCCESS_CODES } = require('../constants/messageCodes')
const storageService = require('../services/storageService')
const logger = require('../utils/logger')
const { verifyOSSCallbackSignature, parseCallbackData } = require('../utils/ossUtils')
const { enqueueMediaUploadIfNeeded } = require('../services/mediaUploadEnqueueService')
const { SUPPORTED_IMAGE_MIME_TYPES, getExtensionFromMimeType } = require('../utils/fileUtils')
const asyncHandler = require('../utils/asyncHandler')
const { throwInvalidParametersError } = require('../utils/requestParams')

/**
 * 获取OSS直传签名
 * POST /images/getUploadSignature
 * Body: { hash, contentType, contentLength }
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetUploadSignature(req, res) {
  const { hash, contentType, contentLength, sessionId } = req.body
  const userId = req?.user?.userId

  if (!hash || !contentType || !contentLength) {
    throwInvalidParametersError({ messageType: 'error' })
  }

  if (!SUPPORTED_IMAGE_MIME_TYPES.has(contentType)) {
    throwInvalidParametersError({ messageType: 'error', message: `不支持的图片格式: ${contentType}` })
  }

  const fileExtension = getExtensionFromMimeType(contentType)

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')

  const storageKey = `images/${userId}/${year}/${month}/${hash.substring(0, 2)}/${hash}.${fileExtension}`

  const uploadSignature = await storageService.getUploadSignature({
    storageKey,
    contentType,
    contentLength,
    userId,
    sessionId
  })

  return res.sendResponse({
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    data: uploadSignature
  })
}

/**
 * 检查去重并添加到队列
 * @param {{userId:number|string,hash:string,fileName:string,fileSize:number,storageKey:string,sessionId:string|null}} callbackData - 回调数据。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function checkAndAddToQueue(callbackData) {
  const { userId, hash, fileName, fileSize, storageKey, sessionId } = callbackData
  await enqueueMediaUploadIfNeeded({
    userId,
    imageHash: hash,
    fileName,
    fileSize,
    storageKey,
    sessionId,
    duplicateAction: 'duplicate_skipped_after_oss_upload',
    duplicateNote: 'OSS storage is overwrite-based, no cleanup needed',
    duplicateDetails: { source: 'ossUploadController' }
  })
}

/**
 * 阿里云OSS图片上传完成回调
 * POST /aliyunOss/mediaUploadCallback
 * Body: OSS回调数据
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function runUploadCallback(req, res) {
  logger.info({
    message: '收到OSS回调请求',
    details: {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body
    }
  })

  const isValid = await verifyOSSCallbackSignature(req)
  if (!isValid) {
    throw new CustomError({
      httpStatus: 403,
      messageType: 'error',
      message: 'Invalid OSS callback signature',
      details: {
        req
      }
    })
  }

  logger.info({
    message: 'OSS回调签名验证成功 开始解析回调数据进行图片入库'
  })

  const callbackData = parseCallbackData(req.body)

  await checkAndAddToQueue(callbackData)

  logger.info({
    message: '图片处理任务添加到队列成功'
  })

  return res.sendResponse({
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED
  })
}

module.exports = {
  handleGetUploadSignature: asyncHandler(handleGetUploadSignature),
  handleUploadCallback: asyncHandler(async (req, res) => {
    try {
      await runUploadCallback(req, res)
    } catch (error) {
      logger.error({
        message: 'OSS回调处理失败',
        details: { error: error.message, stack: error.stack }
      })
      throw error
    }
  })
}
