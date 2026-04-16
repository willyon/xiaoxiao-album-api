/*
 * @Author: zhangshouchang
 * @Date: 2025-08-11
 * @LastEditors: zhangshouchang
 * @Description: 独立图片处理worker模块
 */

const logger = require('../utils/logger')
const { saveNewMedia } = require('../services/mediaService')
const trashService = require('../services/trashService')
const { getRedisClient } = require('../services/redisClient')
const { userSetKey } = require('./userMediaHashset')
const { mediaMetaQueue } = require('../queues/mediaMetaQueue')
const { QUEUE_JOB_ATTEMPTS } = require('../config/queueConfig')
const { bullMqWillRetryAfterThisFailure } = require('../utils/queuePipelineLifecycle')
const storageService = require('../services/storageService')
const videoProcessingService = require('../services/videoProcessingService')
const timeIt = require('../utils/timeIt')
const { updateProgress } = require('../services/mediaProcessingProgressService')

/** Redis 命中但库内仅回收站记录时：静默恢复并计 uploadedCount，删除临时上传文件 */
async function _restoreTrashIfApplicableAndSkipUpload(fileInfo) {
  const { userId, imageHash } = fileInfo
  const { restored } = await trashService.restoreTrashMediaByHashIfApplicable({ userId, imageHash })
  if (!restored) return false
  logger.info({
    message: 'Worker：Redis 命中但仅回收站有记录，已恢复并结束上传',
    details: { imageHash, userId, fileName: fileInfo.fileName }
  })
  if (fileInfo.sessionId) {
    await updateProgress({ sessionId: fileInfo.sessionId, status: 'uploadedCount' })
    await updateProgress({ sessionId: fileInfo.sessionId, status: 'ingestDoneCount' })
  }
  await storageService.deleteFile(fileInfo)
  return true
}

// 原子化：先查集合 → 抢锁 → 失败则再查集合 → 再决定 busy/重复
async function _ensureProcessRightOrShortCircuit(fileInfo, redisClient) {
  const { userId, imageHash } = fileInfo
  const setKey = userSetKey(userId)

  // 1) 快路径：集合命中，立即按重复处理
  const already = await redisClient.sismember(setKey, imageHash)
  if (already === 1) {
    if (await _restoreTrashIfApplicableAndSkipUpload(fileInfo)) {
      return { proceed: false }
    }

    logger.info({
      message: 'Worker检测到重复图片，跳过处理',
      details: {
        imageHash,
        userId,
        fileName: fileInfo.fileName,
        action: 'duplicate_skipped_in_worker'
      }
    })

    // 更新 Worker 层跳过计数（已加入队列但被跳过）
    if (fileInfo.sessionId) {
      await updateProgress({
        sessionId: fileInfo.sessionId,
        status: 'workerSkippedCount'
      })
    }

    await storageService.deleteFile(fileInfo)
    return { proceed: false } // 不继续处理
  }

  // 2) 抢占锁（避免同图并发重复处理）
  const lockKey = `${process.env.MEDIA_HASH_LOCK_KEY_PREFIX}${imageHash}`
  const ttlMs = Number(process.env.MEDIA_HASH_LOCK_TTL_MS) || 10 * 60 * 1000 //10分钟后释放锁 避免因为忘记释放锁导致死锁
  //NX：仅当 key 不存在 时才设置（Not eXists） PX <ms>：给这个 key 设置 过期时间（毫秒）（eXPIRE in ms）
  const lockOk = await redisClient.set(lockKey, '1', 'NX', 'PX', ttlMs)
  if (!lockOk) {
    // 3) 抢锁失败：复查集合（可能另一 worker 已经完成并写入）
    const nowExists = await redisClient.sismember(setKey, imageHash)
    if (nowExists === 1) {
      if (await _restoreTrashIfApplicableAndSkipUpload(fileInfo)) {
        return { proceed: false }
      }

      logger.info({
        message: '抢锁失败后检测到重复图片，跳过处理',
        details: {
          imageHash,
          userId,
          fileName: fileInfo.fileName,
          action: 'duplicate_skipped_after_lock_failed'
        }
      })

      // 更新 Worker 层跳过计数
      if (fileInfo.sessionId) {
        await updateProgress({
          sessionId: fileInfo.sessionId,
          status: 'workerSkippedCount'
        })
      }

      await storageService.deleteFile(fileInfo)
      return { proceed: false }
    }
    // 仍不存在：说明别人正在处理，抛“忙”让队列重试
    const busyErr = new Error('image_processing_in_progress')
    busyErr.code = 'IMG_BUSY'
    throw busyErr
  }

  // 抢锁成功：把锁 key 返回给调用者以便 finally 里释放
  return { proceed: true, lockKey }
}

/**
 * 处理重试失败后的清理工作
 * @param {Object} params - 参数对象
 * @param {Object} params.job - BullMQ job对象
 * @param {string} params.reason - 失败原因
 * @param {string} params.storageKey - 源文件存储键
 * @param {string} params.fileName - 文件名
 * @param {string} params.imageHash - 图片哈希
 * @param {string} params.userId - 用户ID
 * @param {string} [params.thumbnailStorageKey] - 缩略图存储键（可选）
 * @param {unknown} [params.err] - 本次失败错误（用于 UnrecoverableError 等与队列重试策略对齐）
 */
async function _handleRetryFailure({ job, err, reason, storageKey, fileName, imageHash, userId, thumbnailStorageKey }) {
  const maxAttempts = job?.opts?.attempts || QUEUE_JOB_ATTEMPTS
  const attemptsMade = job?.attemptsMade || 0
  const willRetry = bullMqWillRetryAfterThisFailure(job, err)

  if (!willRetry) {
    // 没有重试机会了，执行最终清理
    try {
      // 1. 如果有缩略图，先删除
      if (thumbnailStorageKey) {
        await storageService.storage.deleteFile(thumbnailStorageKey)
      }

      // 2. 移动源文件到失败目录
      const failedType = process.env.MEDIA_STORAGE_KEY_FAILED || 'failed'
      const failedStorageKey = storageService.storage.generateStorageKey(failedType, fileName)
      await storageService.storage.moveFile(storageKey, failedStorageKey)

      logger.info({
        message: 'Failed image moved to failed directory after all retries exhausted',
        details: {
          imageHash,
          userId,
          originalLocation: storageKey,
          failedLocation: failedStorageKey,
          thumbnailCleaned: thumbnailStorageKey,
          reason,
          attemptsMade,
          maxAttempts
        }
      })
    } catch (cleanupError) {
      logger.warn({
        message: 'Failed to cleanup files after all retries exhausted',
        details: {
          thumbnailStorageKey,
          sourceStorageKey: storageKey,
          cleanupError: cleanupError.message,
          fallbackAction: 'manual_cleanup_required'
        }
      })
    }
  } else {
    // 还有重试机会，只清理缩略图（如果有），保留源文件
    if (thumbnailStorageKey) {
      try {
        await storageService.storage.deleteFile(thumbnailStorageKey)
        logger.info({
          message: `${reason}, will retry - thumbnail cleaned`,
          details: {
            imageHash,
            userId,
            fileName,
            thumbnailCleaned: thumbnailStorageKey,
            attemptsMade,
            maxAttempts,
            nextAttempt: attemptsMade + 1
          }
        })
      } catch (cleanupError) {
        logger.warn({
          message: 'Failed to cleanup thumbnail before retry',
          details: {
            thumbnailStorageKey,
            cleanupError: cleanupError.message
          }
        })
      }
    } else {
      logger.info({
        message: `${reason}, will retry`,
        details: {
          imageHash,
          userId,
          fileName,
          attemptsMade,
          maxAttempts,
          nextAttempt: attemptsMade + 1
        }
      })
    }
  }
}

/**
 * 独立的单张图片处理与入库方法
 * @param {Object} job - BullMQ job对象
 */
async function processAndSaveSingleMedia(job) {
  let fileInfo = job.data
  const { fileName, storageKey, userId, imageHash, fileSize, extension, mediaType = 'image' } = fileInfo
  logger.info({ message: '处理文件', details: { fileName, mediaType } })
  const redisClient = getRedisClient()
  let lockKey
  let thumbnailStorageKey

  try {
    // 去重 + 分布式锁
    // const { proceed, lockKey: key } = await timeIt("dedupeAndLock", async () => _ensureProcessRightOrShortCircuit(fileInfo, redisClient));
    const { proceed, lockKey: key } = await _ensureProcessRightOrShortCircuit(fileInfo, redisClient)
    if (!proceed) return
    lockKey = key

    // ======== 快路径：仅产出 preview 缩略图 ========
    // 使用适配器生成存储键名，避免硬编码路径
    const thumbnailType = process.env.MEDIA_STORAGE_KEY_THUMBNAIL || 'thumbnail'
    thumbnailStorageKey = storageService.storage.generateStorageKey(thumbnailType, fileName, extension)

    try {
      if (mediaType === 'video') {
        // 视频：FFmpeg 抽首帧 → Sharp 转 webp → 写入存储
        await timeIt(
          'storeVideoThumbnail',
          async () => {
            await videoProcessingService.storeVideoThumbnail(storageKey, thumbnailStorageKey, storageService.storage, { extension })
          },
          imageHash
        )
      } else {
        // 图片：沿用 Sharp 处理
        await timeIt(
          'processAndStoreImage',
          async () => {
            await storageService.processAndStoreImage({
              fileSize,
              sourceStorageKey: storageKey,
              targetStorageKey: thumbnailStorageKey,
              extension,
              quality: 65,
              resizeWidth: 600
            })
          },
          imageHash
        )
      }
    } catch (error) {
      // 缩略图处理失败
      logger.error({
        message: 'Thumbnail generation failed',
        details: {
          imageHash,
          userId,
          fileName,
          sourceStorageKey: storageKey,
          thumbnailStorageKey,
          error: error.message
        }
      })

      // 处理重试失败逻辑
      await _handleRetryFailure({
        job,
        err: error,
        reason: 'thumbnail_generation_failed',
        storageKey,
        fileName,
        imageHash,
        userId
      })

      throw error
    }

    // ======== 将源文件移动到 original 存储位置（确保后续 meta / 重试都有稳定路径）========
    const originalType = process.env.MEDIA_STORAGE_KEY_ORIGINAL || 'original'
    let originalStorageKey = storageService.storage.generateStorageKey(originalType, fileName)
    try {
      await storageService.storage.moveFile(storageKey, originalStorageKey)
    } catch (e) {
      logger.warn({
        message: 'Upload worker: move original file failed, fallback to temp storageKey',
        details: { imageHash, userId, sourceStorageKey: storageKey, targetStorageKey: originalStorageKey, error: e.message }
      })
      originalStorageKey = storageKey
    }

    // ======== 先写库（仅必要字段，其他走默认值）========
    const imageData = {
      userId,
      imageHash,
      thumbnailStorageKey,
      fileSizeBytes: fileSize,
      mediaType: mediaType === 'video' ? 'video' : 'image',
      originalStorageKey
    }

    try {
      await saveNewMedia(imageData)
      await redisClient.sadd(userSetKey(userId), imageHash)
    } catch (error) {
      // 数据库保存失败
      logger.error({
        message: 'Database save failed',
        details: {
          imageHash,
          userId,
          thumbnailStorageKey,
          sourceStorageKey: storageKey,
          error: error.message
        }
      })

      // 处理重试失败逻辑
      await _handleRetryFailure({
        job,
        err: error,
        reason: 'database_save_failed',
        storageKey,
        fileName,
        imageHash,
        userId,
        thumbnailStorageKey // 数据库保存失败时，需要清理已生成的缩略图
      })

      throw error
    }

    // ======== 入 Meta 阶段队列做"慢活"（EXIF + 高清 AVIF + DB 更新）========
    await mediaMetaQueue.add(
      process.env.MEDIA_META_QUEUE_NAME || 'media-meta',
      {
        userId,
        imageHash,
        fileName,
        originalStorageKey,
        mediaType, // 透传，供 imageMetaIngestor 分支判断
        extension: process.env.MEDIA_HIGHRES_EXTENSION || 'avif',
        fileSize,
        sessionId: fileInfo.sessionId
      },
      {
        jobId: `${userId}:${imageHash}` // 添加 jobId 防止重复加入队列
      }
    )
  } catch (error) {
    // 最外层错误处理 - 记录完整的失败信息
    // 注意：内层catch已经处理了重试逻辑，这里只记录日志
    logger.error({
      message: 'Image processing failed completely',
      details: {
        imageHash,
        userId,
        fileName,
        sourceStorageKey: storageKey,
        thumbnailStorageKey,
        error: error.message,
        stack: error.stack
      }
    })

    throw error // 重新抛出，让 Worker 处理重试逻辑
  } finally {
    // 清理分布式锁
    if (lockKey) {
      try {
        await redisClient.del(lockKey)
      } catch (lockCleanupError) {
        logger.warn({
          message: 'Failed to cleanup distributed lock',
          details: { lockKey, error: lockCleanupError.message }
        })
      }
    }
  }
}

module.exports = {
  processAndSaveSingleMedia
}
