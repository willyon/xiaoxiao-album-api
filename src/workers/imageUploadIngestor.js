/*
 * @Author: zhangshouchang
 * @Date: 2025-08-11
 * @LastEditors: zhangshouchang
 * @Description: 独立图片处理worker模块
 */

const logger = require("../utils/logger");
const path = require("path");
const os = require("os");
const fsExtra = require("fs-extra");
const { saveNewImage, cleanupGeneratedFile, formatSingleImage } = require("../services/imageService");
const { getRedisClient } = require("../services/redisClient");
const { userSetKey } = require("./userImageHashset");
const { imageMetaQueue } = require("../queues/imageMetaQueue");
const StorageService = require("../services/StorageService");
const { STORAGE_TYPES } = require("../storage/constants/StorageTypes");
const timeIt = require("../utils/timeIt");

async function _handleRemoveThumbnail(thumbnailPath, filename, sourcePath) {
  try {
    await cleanupGeneratedFile(thumbnailPath);
  } catch (err) {
    // 失败兜底：把源文件挪到 failed
    try {
      const failedPath = path.join(failedFolder, filename);
      await fsExtra.move(sourcePath, failedPath, { overwrite: true });
    } catch (e) {
      // 记录移动到failed目录失败，但不要覆盖原始 err
      logger.error({
        message: `moved to failed Folder failed: ${e?.message}`,
        stack: e?.stack,
        details: { failedPath, filename, sourcePath },
      });
    }
    throw err;
  }
}

// 处理重复图片：记录日志并删除文件
async function _handleDuplicatedImage(fileInfo) {
  const { filename, path: sourcePath, userId, imageHash } = fileInfo;

  try {
    // 记录重复图片信息到日志
    logger.info({
      message: "Duplicate image detected and removed",
      details: {
        filename,
        imageHash,
        userId,
        sourcePath,
        timestamp: Date.now(),
        action: "deleted",
      },
    });

    // 直接删除重复的上传文件
    await fsExtra.remove(sourcePath);

    logger.info({
      message: "Duplicate image file deleted successfully",
      details: { filename, sourcePath },
    });
  } catch (error) {
    logger.error({
      message: `Failed to delete duplicate image file: ${error?.message}`,
      stack: error?.stack,
      details: { sourcePath, filename, imageHash, userId },
    });
    // 即使删除失败也不要抛出错误，避免影响主流程
  }
}

// 原子化：先查集合 → 抢锁 → 失败则再查集合 → 再决定 busy/重复
async function _ensureProcessRightOrShortCircuit(fileInfo, redisClient) {
  const { userId, imageHash } = fileInfo;
  const setKey = userSetKey(userId);

  // 1) 快路径：集合命中，立即按重复处理
  const already = await redisClient.sismember(setKey, imageHash);
  if (already === 1) {
    await _handleDuplicatedImage(fileInfo);
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
      await _handleDuplicatedImage(fileInfo);
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
 * 根据存储类型获取文件的本地临时路径
 * @param {Object} fileInfo - 文件信息
 * @returns {Promise<{tempPath: string, cleanup: Function}>} 临时文件路径和清理函数
 */
async function _getFileForProcessing(fileInfo) {
  const { storageKey, storageType, filename } = fileInfo;
  const storageService = new StorageService();

  if (storageType === STORAGE_TYPES.LOCAL) {
    // 本地存储：直接使用文件路径
    return {
      tempPath: storageKey, // storageKey 就是本地文件路径
      cleanup: async () => {}, // 本地文件不需要清理临时文件
    };
  } else {
    // OSS存储：下载到临时文件
    const tempDir = os.tmpdir();
    const tempPath = path.join(tempDir, `temp_${Date.now()}_${filename}`);

    try {
      // 从OSS下载文件内容
      const fileBuffer = await storageService.getFileBuffer(storageKey);
      await fsExtra.writeFile(tempPath, fileBuffer);

      return {
        tempPath,
        cleanup: async () => {
          try {
            await fsExtra.remove(tempPath);
          } catch (error) {
            logger.warn({
              message: "Failed to cleanup temporary file",
              details: { tempPath, error: error.message },
            });
          }
        },
      };
    } catch (error) {
      // 清理可能创建的临时文件
      try {
        await fsExtra.remove(tempPath);
      } catch {}
      throw error;
    }
  }
}

/**
 * 独立的单张图片处理与入库方法
 * @param {Object} fileInfo - 包含图片文件信息的对象，需至少有 filename、storageKey、userId、storageType 字段
 */
async function processAndSaveSingleImage(fileInfo) {
  const { filename, storageKey, userId, imageHash, storageType } = fileInfo;
  console.log("处理文件:", filename, "存储类型:", storageType);
  const redisClient = getRedisClient();
  const storageService = new StorageService();
  let lockKey;
  let fileCleanup;

  try {
    // 去重 + 分布式锁
    // const { proceed, lockKey: key } = await timeIt("dedupeAndLock", async () => _ensureProcessRightOrShortCircuit(fileInfo, redisClient));
    const { proceed, lockKey: key } = await _ensureProcessRightOrShortCircuit(fileInfo, redisClient);
    if (!proceed) return;
    lockKey = key;

    // 获取文件用于处理（本地直接使用，OSS下载到临时文件）
    const { tempPath, cleanup } = await _getFileForProcessing(fileInfo);
    fileCleanup = cleanup;

    // ======== 快路径：仅产出 preview.webp ========
    // 使用适配器生成存储键名，避免硬编码路径
    const imgExtension = process.env.IMAGE_EXTENSION_WEBP || "webp";
    const thumbnailStorageKey = storageService.generateProcessedImageKey("thumbnail", filename, imgExtension);

    let thumbnailOutputPath;
    let needsCleanup = false;

    try {
      if (storageType === STORAGE_TYPES.LOCAL) {
        // 本地存储：直接输出到目标路径，无需临时文件
        thumbnailOutputPath = storageService.adapter._getFullPath(thumbnailStorageKey);
        // 确保目标目录存在
        await fsExtra.ensureDir(path.dirname(thumbnailOutputPath));
      } else {
        // OSS存储：输出到临时文件，稍后上传
        thumbnailOutputPath = path.join(os.tmpdir(), `thumb_${Date.now()}_${path.basename(filename, path.extname(filename))}.${imgExtension}`);
        needsCleanup = true;
      }

      await timeIt(
        "formatSingleImage",
        async () => {
          // 预览图（webp, 600px）
          await formatSingleImage({
            inputPath: tempPath,
            outputPath: thumbnailOutputPath,
            quality: 50, //建议50-55
            resizeWidth: 600,
          });
        },
        imageHash,
      );

      // OSS存储需要上传临时文件到OSS
      if (storageType === STORAGE_TYPES.ALIYUN_OSS) {
        await storageService.storeFile(thumbnailOutputPath, thumbnailStorageKey);
      }
    } catch (error) {
      // 清理临时缩略图文件（仅OSS模式）
      if (needsCleanup && thumbnailOutputPath) {
        try {
          await fsExtra.remove(thumbnailOutputPath);
        } catch (cleanupErr) {
          logger.warn({
            message: "Failed to cleanup temporary thumbnail file",
            details: { thumbnailOutputPath, error: cleanupErr.message },
          });
        }
      }
      throw error;
    } finally {
      // 清理临时缩略图文件（仅OSS模式）
      if (needsCleanup && thumbnailOutputPath) {
        try {
          await fsExtra.remove(thumbnailOutputPath);
        } catch (cleanupErr) {
          logger.warn({
            message: "Failed to cleanup temporary thumbnail file in finally",
            details: { thumbnailOutputPath, error: cleanupErr.message },
          });
        }
      }
    }

    // ======== 先写库（creationDate 为空；monthKey/yearKey = 'unknown'；bigHigh 先留空或保留旧值）========
    const imageData = {
      originalUrl: "", // 先空着，待 imageMetaWorker 填充
      highResUrl: "", // 先空着，待 imageMetaWorker 填充
      thumbnailUrl: thumbnailStorageKey, // 使用存储服务生成URL
      creationDate: null,
      hash: imageHash,
      userId,
      monthKey: "unknown",
      yearKey: "unknown",
    };

    try {
      await saveNewImage(imageData);
      await redisClient.sadd(userSetKey(userId), imageHash);
    } catch (error) {
      // 数据库保存失败，清理已存储的缩略图
      try {
        await storageService.deleteFile(thumbnailStorageKey);
      } catch (cleanupErr) {
        logger.error({
          message: "Failed to cleanup thumbnail after DB save failed",
          details: { thumbnailStorageKey, error: cleanupErr.message },
        });
      }
      throw error;
    }

    // ======== 入 Meta 队列做"慢活"（EXIF + 高清 AVIF + DB 更新）========
    await imageMetaQueue.add(process.env.IMAGE_META_QUEUE_NAME, {
      userId,
      imageHash,
      filename,
      storageKey, // 传递原始文件的存储键名
      storageType, // 传递存储类型
      highResExt: process.env.IMAGE_EXTENSION_AVIF,
    });
  } finally {
    // 清理分布式锁
    if (lockKey) {
      try {
        await redisClient.del(lockKey);
      } catch {}
    }

    // 清理临时文件
    if (fileCleanup) {
      try {
        await fileCleanup();
      } catch (error) {
        logger.warn({
          message: "Failed to cleanup temporary file in finally",
          details: { storageKey, error: error.message },
        });
      }
    }
  }
}

module.exports = {
  processAndSaveSingleImage,
};
