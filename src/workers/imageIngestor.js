/*
 * @Author: zhangshouchang
 * @Date: 2025-08-11
 * @LastEditors: zhangshouchang
 * @Description: 独立图片处理worker模块
 */

const logger = require("../utils/logger");
const path = require("path");
const fsExtra = require("fs-extra");
const imageService = require("../services/imageService");
const { stringToTimestamp } = require("../utils/formatTime");
const { getRedisClient } = require("../services/redisClient");
const { userSetKey } = require("../workers/sharedEnsure");
const { DateTime } = require("luxon");

// ========================== Timezone helpers (Luxon) ========================== //
// TIMEZONE can be 'utc' or 'local' (default: 'local')
const TIMEZONE = (process.env.TIMEZONE || "local").toLowerCase() === "utc" ? "utc" : "local";

/**
 * Derive monthKey like '2025-08' from a millisecond timestamp using Luxon.
 * When ts is falsy or invalid => return 'unknown'.
 */
function toMonthKey(ts) {
  if (ts == null) return "unknown";
  const dt = DateTime.fromMillis(Number(ts), { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("yyyy-LL") : "unknown";
}

/**
 * Derive yearKey like '2025' from a millisecond timestamp using Luxon.
 * When ts is falsy or invalid => return 'unknown'.
 */
function toYearKey(ts) {
  if (ts == null) return "unknown";
  const dt = DateTime.fromMillis(Number(ts), { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("yyyy") : "unknown";
}

// 格式化图片后缀名
const imgExtension = process.env.PROCESSED_IMAGE_TARGET_EXTENSION;

// 失败图片存放目录（防止失败文件滞留待处理目录）
const failedFolder = path.join(__dirname, "..", "..", process.env.FAILED_IMAGE_DIR);
// 重复图片存放目录
const duplicateFolder = path.join(__dirname, "..", "..", process.env.DUPLICATE_IMAGE_DIR);
// 存放处理成功图片的源图片文件夹
const originalFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_ORIGINAL_IMAGE_DIR);
// 转换高质量大图目录
const bigHighImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_BIG_HIGH_IMAGE_DIR);
// 转换低质量大图目录
const bigLowImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_BIG_LOW_IMAGE_DIR);
// 转换小图目录
const previewImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_PREVIEW_IMAGE_DIR);

// 确保目标文件夹存在 若不存在 会自动创建
fsExtra.ensureDirSync(failedFolder);
fsExtra.ensureDirSync(duplicateFolder);
fsExtra.ensureDirSync(originalFolder);
fsExtra.ensureDirSync(bigHighImageFolder);
fsExtra.ensureDirSync(bigLowImageFolder);
fsExtra.ensureDirSync(previewImageFolder);

const handleDuplicatedImage = async (fileInfo) => {
  const filename = fileInfo.filename;
  const sourceFilePath = fileInfo.path;
  // 处理重复图片逻辑
  const duplicateFilePath = path.join(duplicateFolder, filename);
  try {
    await fsExtra.move(sourceFilePath, duplicateFilePath, { overwrite: true });
  } catch (error) {
    logger.error({
      message: `File processing failed, error message: ${error?.message}`,
      stack: error?.stack,
      details: { step: "move duplicated file.", file: fileInfo.path, sourceFilePath, duplicateFilePath },
    });
  }
};

/**
 * 独立的单张图片处理与入库方法
 * @param {Object} fileInfo - 包含图片文件信息的对象，需至少有 filename、path、userId 字段
 */
async function processAndSaveSingleImage(fileInfo) {
  const { filename, path: sourceFilePath, userId } = fileInfo;

  // 计算图片哈希值
  let imageHash;
  try {
    imageHash = await imageService.calculateImageHash(sourceFilePath);
  } catch (error) {
    logger.error({
      message: `File processing failed, error message: ${error?.message}`,
      stack: error?.stack,
      details: { step: "calculateImageHash", file: fileInfo.path },
    });
    // 将源文件移入失败目录，避免滞留
    try {
      const failedPath = path.join(failedFolder, filename);
      await fsExtra.move(sourceFilePath, failedPath, { overwrite: true });
    } catch (e2) {
      logger.warn({
        message: `move failed image to failedFolder failed: ${e2?.message}`,
        details: { step: "move failed image (hash)", file: fileInfo.path },
      });
    }
    return;
  }

  // 检查是否重复/并发锁
  let redisClient = getRedisClient();
  // 分布式锁 + 集合(健壮去重)
  const lockPrefix = process.env.IMAGES_HASH_LOCK_KEY_PREFIX;
  const lockKey = `${lockPrefix}${imageHash}`;
  const lockTtlMs = Number(process.env.IMAGE_HASH_LOCK_TTL_MS); // 默认10分钟
  // 抢占处理资格：SET NX PX ttl（已存在或他人处理中则拿不到锁）
  const lockOk = await redisClient.set(lockKey, "1", "NX", "PX", lockTtlMs);
  // 未拿到锁
  if (!lockOk) {
    try {
      const known = await redisClient.sismember(userSetKey(userId), imageHash);
      // 判断一次去重
      if (known === 1) {
        await handleDuplicatedImage(fileInfo);
        return;
      }
      // 不在集合里：说明其他 worker 正在处理同一图片，抛出可重试错误，交给队列重试
      const busyErr = new Error("image_processing_in_progress");
      busyErr.code = "IMG_BUSY";
      throw busyErr;
    } catch (e) {
      // 安全兜底：如果上面判断出错，记录并以重试方式结束
      logger.warn({ message: `check duplicate via lock+set failed: ${e?.message}`, details: { file: fileInfo.path } });
      const busyErr = new Error("image_processing_in_progress");
      busyErr.code = "IMG_BUSY";
      throw busyErr;
    }
  }
  //拿到锁 则继续往下走
  try {
    const isDuplicate = await redisClient.sismember(userSetKey(userId), imageHash);
    if (isDuplicate === 1) {
      await handleDuplicatedImage(fileInfo);
      return;
    }

    // 转换路径
    const bigHighFilePath = path.join(bigHighImageFolder, `${imageHash}.${imgExtension}`);
    const bigLowFilePath = path.join(bigLowImageFolder, `${imageHash}.${imgExtension}`);
    const previewFilePath = path.join(previewImageFolder, `${imageHash}.${imgExtension}`);

    // 图片格式化并添加到相应文件夹
    try {
      await Promise.all([
        imageService.formatImage([sourceFilePath, "-quality", "50", bigHighFilePath]),
        imageService.formatImage([sourceFilePath, "-quality", "10", bigLowFilePath]),
        imageService.formatImage([sourceFilePath, "-quality", "50", "-resize", "600x", previewFilePath]),
      ]);
    } catch (error) {
      await imageService.rollbackOperation(bigHighFilePath);
      await imageService.rollbackOperation(bigLowFilePath);
      await imageService.rollbackOperation(previewFilePath);
      logger.error({
        message: `File processing failed, error message: ${error?.message}`,
        stack: error?.stack,
        details: { step: "format image", file: fileInfo.path },
      });
      // 将图片移动至操作失败文件夹下保存
      try {
        const failedPath = path.join(failedFolder, filename);
        await fsExtra.move(sourceFilePath, failedPath, { overwrite: true });
      } catch (e2) {
        logger.warn({
          message: `move failed image to failedFolder failed: ${e2?.message}`,
          details: { step: "move failed image (format)", file: fileInfo.path },
        });
      }
      return;
    }

    // 读取元数据
    let creationDate = null;
    let exifData;
    try {
      exifData = await imageService.extractImageMetadata(sourceFilePath);
      creationDate = exifData.DateTimeOriginal ? stringToTimestamp(exifData.DateTimeOriginal.rawValue) : null;
    } catch (error) {
      logger.error({
        message: `File processing failed, error message: ${error?.message}`,
        stack: error?.stack,
        details: { step: "fail to extract image metadata", file: fileInfo.path },
      });
      // 将图片移动至操作失败文件夹下保存
      try {
        const failedPath = path.join(failedFolder, filename);
        await fsExtra.move(sourceFilePath, failedPath, { overwrite: true });
      } catch (e2) {
        logger.warn({
          message: `move failed image to failedFolder failed: ${e2?.message}`,
          details: { step: "move failed image (exif)", file: fileInfo.path },
        });
      }
      return;
    }

    // Compute materialized keys for faster grouping/queries
    const monthKey = toMonthKey(creationDate);
    const yearKey = toYearKey(creationDate);

    const imageData = {
      originalImageUrl: path.join(`/${process.env.PROCESSED_ORIGINAL_IMAGE_DIR}`, filename),
      bigHighQualityImageUrl: path.join(`/${process.env.PROCESSED_BIG_HIGH_IMAGE_DIR}`, `${imageHash}.${imgExtension}`),
      bigLowQualityImageUrl: path.join(`/${process.env.PROCESSED_BIG_LOW_IMAGE_DIR}`, `${imageHash}.${imgExtension}`),
      previewImageUrl: path.join(`/${process.env.PROCESSED_PREVIEW_IMAGE_DIR}`, `${imageHash}.${imgExtension}`),
      creationDate,
      hash: imageHash,
      userId: fileInfo.userId,
      monthKey,
      yearKey,
    };

    // 保存至数据库
    try {
      await imageService.saveNewImage(imageData);
      // 将当前新增图片hash写入redis中
      await redisClient.sadd(userSetKey(userId), imageHash);
    } catch (error) {
      await imageService.rollbackOperation(bigHighFilePath);
      await imageService.rollbackOperation(bigLowFilePath);
      await imageService.rollbackOperation(previewFilePath);
      logger.error({
        message: `File processing failed, error message: ${error?.message}`,
        stack: error?.stack,
        details: { step: "fail to insert new image data", file: fileInfo.path },
      });
      // 将图片移动至操作失败文件夹下保存
      try {
        const failedPath = path.join(failedFolder, filename);
        await fsExtra.move(sourceFilePath, failedPath, { overwrite: true });
      } catch (e2) {
        logger.warn({
          message: `move failed image to failedFolder failed: ${e2?.message}`,
          details: { step: "move failed image (db)", file: fileInfo.path },
        });
      }
      return;
    }

    // 移动原图
    const originalFilePath = path.join(originalFolder, filename);
    try {
      await fsExtra.move(sourceFilePath, originalFilePath, { overwrite: true });
    } catch (error) {
      logger.error({
        message: `File processing failed, error message: ${error?.message}`,
        stack: error?.stack,
        details: { step: "fail to move image to original folder", file: fileInfo.path, sourceFilePath, originalFilePath },
      });
    }
  } finally {
    // 无论成功或失败都释放锁（仅当我们曾拿到锁时才有意义）
    try {
      await redisClient.del(lockKey);
    } catch {}
  }
}

module.exports = {
  processAndSaveSingleImage,
};
