/*
 * @Author: zhangshouchang
 * @Date: 2025-08-11
 * @LastEditors: zhangshouchang
 * @Description: 独立图片处理worker模块
 */

const logger = require("../utils/logger");
const { saveNewImage } = require("../services/imageService");
const { getRedisClient } = require("../services/redisClient");
const { userSetKey } = require("./userImageHashset");
const { imageMetaQueue } = require("../queues/imageMetaQueue");
const storageService = require("../services/storageService");
const timeIt = require("../utils/timeIt");
const { getDefaultStorageType } = require("../storage/constants/StorageTypes");
const { updateProgress } = require("../services/imageProcessingProgressService");

// 原子化：先查集合 → 抢锁 → 失败则再查集合 → 再决定 busy/重复
async function _ensureProcessRightOrShortCircuit(fileInfo, redisClient) {
  const { userId, imageHash } = fileInfo;
  const setKey = userSetKey(userId);

  // 1) 快路径：集合命中，立即按重复处理
  const already = await redisClient.sismember(setKey, imageHash);
  if (already === 1) {
    await storageService.deleteFile(fileInfo);
    return { proceed: false }; // 不继续处理
  }

  // 2) 抢占锁（避免同图并发重复处理）
  const lockKey = `${process.env.IMAGES_HASH_LOCK_KEY_PREFIX}${imageHash}`;
  const ttlMs = Number(process.env.IMAGE_HASH_LOCK_TTL_MS) || 10 * 60 * 1000; //10分钟后释放锁 避免因为忘记释放锁导致死锁
  //NX：仅当 key 不存在 时才设置（Not eXists） PX <ms>：给这个 key 设置 过期时间（毫秒）（eXPIRE in ms）
  const lockOk = await redisClient.set(lockKey, "1", "NX", "PX", ttlMs);
  if (!lockOk) {
    // 3) 抢锁失败：复查集合（可能另一 worker 已经完成并写入）
    const nowExists = await redisClient.sismember(setKey, imageHash);
    if (nowExists === 1) {
      await storageService.deleteFile(fileInfo);
      return { proceed: false };
    }
    // 仍不存在：说明别人正在处理，抛“忙”让队列重试
    const busyErr = new Error("image_processing_in_progress");
    busyErr.code = "IMG_BUSY";
    throw busyErr;
  }

  // 抢锁成功：把锁 key 返回给调用者以便 finally 里释放
  return { proceed: true, lockKey };
}

/**
 * 独立的单张图片处理与入库方法
 * @param {Object} fileInfo - 包含图片文件信息的对象
 * @param {string} fileInfo.fileName - 文件名
 * @param {string} fileInfo.storageKey - 存储键名
 * @param {string} fileInfo.userId - 用户ID
 * @param {string} fileInfo.imageHash - 图片哈希
 * @param {number} fileInfo.fileSize - 文件大小
 * @param {string} [fileInfo.extension="webp"] - 缩略图扩展名
 */
async function processAndSaveSingleImage(fileInfo) {
  const { fileName, storageKey, userId, imageHash, fileSize, extension } = fileInfo;
  logger.info({ message: "处理文件", details: { fileName } });
  const redisClient = getRedisClient();
  let lockKey;
  let thumbnailStorageKey;

  try {
    // 去重 + 分布式锁
    // const { proceed, lockKey: key } = await timeIt("dedupeAndLock", async () => _ensureProcessRightOrShortCircuit(fileInfo, redisClient));
    const { proceed, lockKey: key } = await _ensureProcessRightOrShortCircuit(fileInfo, redisClient);
    if (!proceed) return;
    lockKey = key;

    // ======== 快路径：仅产出 preview 缩略图 ========
    // 使用适配器生成存储键名，避免硬编码路径
    const thumbnailType = process.env.IMAGE_STORAGE_KEY_THUMBNAIL || "thumbnail";
    thumbnailStorageKey = storageService.storage.generateStorageKey(thumbnailType, fileName, extension);

    try {
      await timeIt(
        "processAndStoreImage",
        async () => {
          // 从存储读取原图，处理后存储缩略图
          await storageService.processAndStoreImage({
            fileSize,
            sourceStorageKey: storageKey,
            targetStorageKey: thumbnailStorageKey,
            extension,
            quality: 65, // webp建议 缩略图60-70 高清图75-85
            resizeWidth: 600,
          });
        },
        imageHash,
      );
    } catch (error) {
      // 缩略图处理失败，将原始文件移动到失败目录
      logger.error({
        message: "Thumbnail generation failed",
        details: {
          imageHash,
          userId,
          fileName,
          sourceStorageKey: storageKey,
          thumbnailStorageKey,
          error: error.message,
        },
      });

      try {
        // 生成失败文件存储键名并移动文件
        const failedType = process.env.IMAGE_STORAGE_KEY_FAILED || "failed";
        const failedStorageKey = storageService.storage.generateStorageKey(failedType, fileName);
        await storageService.storage.moveFile(storageKey, failedStorageKey);

        logger.info({
          message: "Failed image moved to failed directory",
          details: {
            imageHash,
            userId,
            originalLocation: storageKey,
            failedLocation: failedStorageKey,
            reason: "thumbnail_generation_failed",
          },
        });
      } catch (moveError) {
        logger.warn({
          message: "Failed to move source file to failed directory after thumbnail generation failure",
          details: {
            storageKey,
            moveError: moveError.message,
            fallbackAction: "file_remains_in_original_location",
          },
        });
      }

      // 更新处理进度（失败）
      if (fileInfo.sessionId) {
        await updateProgress({
          sessionId: fileInfo.sessionId,
          imageHash,
          status: "errors",
        });
      }

      throw error;
    }

    // ======== 先写库（creationDate 为空；monthKey/yearKey = 'unknown'；bigHigh 先留空或保留旧值）========
    const imageData = {
      originalStorageKey: "", // 先空着，待 imageMetaWorker 填充
      highResStorageKey: "", // 先空着，待 imageMetaWorker 填充
      thumbnailStorageKey: thumbnailStorageKey, // 使用存储服务生成URL
      creationDate: null,
      imageHash,
      userId,
      monthKey: "unknown",
      yearKey: "unknown",
      storageType: getDefaultStorageType(), // 动态获取当前存储类型
      fileSize, // 文件大小（字节）
    };

    try {
      await saveNewImage(imageData);
      await redisClient.sadd(userSetKey(userId), imageHash);

      // 更新处理进度（成功）
      if (fileInfo.sessionId) {
        await updateProgress({
          sessionId: fileInfo.sessionId,
          imageHash,
          status: "thumbDone",
        });
      }
    } catch (error) {
      // 数据库保存失败，将原始文件移动到失败目录并清理缩略图
      logger.error({
        message: "Database save failed, moving to failed directory and cleaning up thumbnail",
        details: {
          imageHash,
          userId,
          thumbnailStorageKey,
          sourceStorageKey: storageKey,
          error: error.message,
        },
      });

      try {
        // 1. 先删除已生成的缩略图
        await storageService.storage.deleteFile(thumbnailStorageKey);

        // 2. 生成失败文件存储键名并移动文件
        const failedType = process.env.IMAGE_STORAGE_KEY_FAILED || "failed";
        const failedStorageKey = storageService.storage.generateStorageKey(failedType, fileName);
        await storageService.storage.moveFile(storageKey, failedStorageKey);

        logger.info({
          message: "Failed image moved to failed directory after database save failure",
          details: {
            imageHash,
            userId,
            originalLocation: storageKey,
            failedLocation: failedStorageKey,
            thumbnailCleaned: thumbnailStorageKey,
            reason: "database_save_failed",
          },
        });
      } catch (cleanupError) {
        logger.warn({
          message: "Failed to cleanup files after database save failure",
          details: {
            thumbnailStorageKey,
            sourceStorageKey: storageKey,
            cleanupError: cleanupError.message,
            fallbackAction: "manual_cleanup_required",
          },
        });
      }

      throw error;
    }

    // ======== 入 Meta 队列做"慢活"（EXIF + 高清 AVIF + DB 更新）========
    await imageMetaQueue.add(process.env.IMAGE_META_QUEUE_NAME, {
      userId,
      imageHash,
      fileName,
      storageKey, // 传递原始文件的存储键名
      extension: process.env.IMAGE_HIGHRES_EXTENSION || "avif",
      fileSize, // 传递文件大小
      sessionId: fileInfo.sessionId, // 传递会话ID用于进度跟踪
    });

    logger.info({
      message: "Image processing completed successfully",
      details: {
        imageHash,
        userId,
        fileName,
        thumbnailStorageKey,
      },
    });
  } catch (error) {
    // 最外层错误处理 - 记录完整的失败信息
    logger.error({
      message: "Image processing failed completely",
      details: {
        imageHash,
        userId,
        fileName,
        sourceStorageKey: storageKey,
        thumbnailStorageKey,
        error: error.message,
        stack: error.stack,
      },
    });

    throw error; // 重新抛出，让 Worker 处理重试逻辑
  } finally {
    // 清理分布式锁
    if (lockKey) {
      try {
        await redisClient.del(lockKey);
      } catch (lockCleanupError) {
        logger.warn({
          message: "Failed to cleanup distributed lock",
          details: { lockKey, error: lockCleanupError.message },
        });
      }
    }
  }
}

module.exports = {
  processAndSaveSingleImage,
};
