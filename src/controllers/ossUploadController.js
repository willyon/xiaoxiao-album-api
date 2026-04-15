/*
 * @Author: zhangshouchang
 * @Date: 2025-09-07 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-09-07 10:00:00
 * @Description: 预检和直传相关控制器
 */
const CustomError = require('../errors/customError')
const { SUCCESS_CODES, ERROR_CODES } = require('../constants/messageCodes')
const storageService = require('../services/storageService')
const { mediaUploadQueue } = require('../queues/mediaUploadQueue')
const logger = require('../utils/logger')
const { verifyOSSCallbackSignature, parseCallbackData } = require('../utils/ossCallbackUtils')
const { updateProgress } = require('../services/mediaProcessingProgressService')
const { SUPPORTED_IMAGE_MIME_TYPES, getExtensionFromMimeType } = require('../utils/fileUtils')

/**
 * 获取OSS直传签名
 * POST /images/getUploadSignature
 * Body: { hash, contentType, contentLength }
 */
async function handleGetUploadSignature(req, res, next) {
  try {
    const { hash, contentType, contentLength, sessionId } = req.body
    const userId = req?.user?.userId

    if (!hash || !contentType || !contentLength) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error'
      })
    }

    // 验证 contentType 有效性（防止前端伪造）
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(contentType)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: 'error',
        message: `不支持的图片格式: ${contentType}`
      })
    }

    // 从 MIME 类型提取文件扩展名（使用公共方法）
    const fileExtension = getExtensionFromMimeType(contentType)

    // 生成基于时间的storageKey
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')

    // images/userId/year/month/hashPrefix/hash.ext
    const storageKey = `images/${userId}/${year}/${month}/${hash.substring(0, 2)}/${hash}.${fileExtension}`

    // 获取OSS上传签名
    const uploadSignature = await storageService.getUploadSignature({
      storageKey,
      contentType,
      contentLength,
      userId,
      sessionId
    })

    return res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: uploadSignature // 直接返回适配器的结果
    })
  } catch (error) {
    next(error)
  }
}

/**
 * 检查去重并添加到队列
 * @param {Object} callbackData - 回调数据
 */
async function checkAndAddToQueue(callbackData) {
  const { userId, hash, fileName, fileSize, storageKey, sessionId } = callbackData
  // 统一使用冒号格式，与 uploadController 保持一致
  const jobId = `${userId}:${hash}`
  const existingJob = await mediaUploadQueue.getJob(jobId)

  if (existingJob) {
    // 发现重复任务，记录日志
    logger.info({
      message: 'Duplicate OSS upload job detected, skipping queue processing',
      details: {
        jobId,
        userId,
        imageHash: hash,
        storageKey,
        fileName,
        action: 'duplicate_skipped_after_oss_upload',
        note: 'OSS storage is overwrite-based, no cleanup needed'
      }
    })

    // 更新重复文件计数，保持前后端数据一致
    await updateProgress({
      sessionId,
      status: 'duplicateCount'
    })

    return // 是重复任务，直接返回
  }

  // 没有重复，添加到队列进行后续处理（生成缩略图、EXIF提取等）
  await mediaUploadQueue.add(
    process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload',
    {
      fileName,
      fileSize,
      storageKey,
      userId,
      imageHash: hash,
      extension: process.env.MEDIA_THUMBNAIL_EXTENSION || 'webp',
      sessionId: sessionId // 传递会话ID
    },
    {
      jobId: jobId
    }
  )

  // 更新会话的uploadedCount（非阻塞，不影响主流程）
  await updateProgress({
    sessionId,
    status: 'uploadedCount'
  })
}

/**
 * 阿里云OSS图片上传完成回调
 * POST /aliyunOss/mediaUploadCallback
 * Body: OSS回调数据
 */
async function handleUploadCallback(req, res, next) {
  try {
    // 记录回调请求
    logger.info({
      message: '收到OSS回调请求',
      details: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body
      }
    })

    // 1. 验证回调签名
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

    // 2. 解析回调数据
    const callbackData = parseCallbackData(req.body)

    // 3. 检查去重并添加到队列
    await checkAndAddToQueue(callbackData)

    logger.info({
      message: '图片处理任务添加到队列成功'
    })

    // 4. 返回成功响应给OSS
    return res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED
    })
  } catch (error) {
    logger.error({
      message: 'OSS回调处理失败',
      details: { error: error.message, stack: error.stack }
    })
    next(error)
  }
}

module.exports = {
  handleGetUploadSignature,
  handleUploadCallback
}
