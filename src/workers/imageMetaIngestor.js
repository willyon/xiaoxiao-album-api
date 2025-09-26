/*
 * @Author: zhangshouchang
 * @Date: 2025-08-31
 * @Description: meta 阶段（EXIF + 高清产物 + DB 补充）的独立处理器
 */

const logger = require("../utils/logger");
const { extractImageMetadata, updateImageMetaAndHQ, calculateOrientationInfo } = require("../services/imageService");
const { timestampToYearMonth, timestampToYear, timestampToDate, timestampToDayOfWeek } = require("../utils/formatTime");
const timeIt = require("../utils/timeIt");
const storageService = require("../services/storageService");
const { getLocationFromCoordinates } = require("../services/geocodingService");
const { updateProgress } = require("../services/imageProcessingProgressService");

/**
 * 处理重试失败后的清理工作（用于imageMetaIngestor）
 * @param {Object} params - 参数对象
 * @param {Object} params.job - BullMQ job对象
 * @param {string} params.reason - 失败原因
 * @param {string} params.storageKey - 源文件存储键
 * @param {string} params.fileName - 文件名
 * @param {string} params.imageHash - 图片哈希
 * @param {string} params.userId - 用户ID
 * @param {string} [params.highResStorageKey] - 高清图存储键（可选）
 */
async function handleMetaRetryFailure({ job, reason, storageKey, fileName, imageHash, userId, highResStorageKey }) {
  const maxAttempts = job?.opts?.attempts || Number(process.env.IMAGE_META_JOB_ATTEMPTS || 5);
  const attemptsMade = job?.attemptsMade || 0;
  const willRetry = attemptsMade < maxAttempts;

  if (!willRetry) {
    // 没有重试机会了，执行最终清理
    try {
      // 1. 如果有高清图，先删除
      if (highResStorageKey) {
        await storageService.storage.deleteFile(highResStorageKey);
      }

      logger.info({
        message: "High-res image processing failed after all retries exhausted",
        details: {
          imageHash,
          userId,
          highResCleaned: highResStorageKey,
          reason,
          attemptsMade,
          maxAttempts,
        },
      });
    } catch (cleanupError) {
      logger.warn({
        message: "Failed to cleanup files after all retries exhausted",
        details: {
          highResStorageKey,
          cleanupError: cleanupError.message,
          fallbackAction: "manual_cleanup_required",
        },
      });
    }

    // 4. 更新处理进度（最终失败）
    if (job.data.sessionId) {
      await updateProgress({
        sessionId: job.data.sessionId,
        status: "highResErrors",
      });
    }
  } else {
    // 还有重试机会，只清理已生成的高清图，保留源文件
    let highResCleaned = false;

    if (highResStorageKey) {
      try {
        await storageService.storage.deleteFile(highResStorageKey);
        highResCleaned = true;
      } catch (cleanupError) {
        logger.warn({
          message: "Failed to cleanup highRes file before retry",
          details: {
            highResStorageKey,
            cleanupError: cleanupError.message,
          },
        });
      }
    }

    logger.info({
      message: `${reason}, will retry${highResCleaned ? " - highRes cleaned" : ""}`,
      details: {
        imageHash,
        userId,
        fileName,
        highResCleaned,
        attemptsMade,
        maxAttempts,
        nextAttempt: attemptsMade + 1,
      },
    });
  }

  return { willRetry };
}

/**
 * 处理单张图片的"后处理"：
 * 1) 读取 EXIF → creationDate/monthKey/yearKey
 * 2) 产出高清大图（默认 AVIF）
 * 3) 更新数据库（补 creationDate/monthKey/yearKey/highResStorageKey）
 * 4) 将原图移动至 original 存储位置
 *
 * @param {Object} job - BullMQ job对象
 */
async function processImageMeta(job) {
  const { userId, imageHash, fileName, storageKey, extension, fileSize, sessionId } = job.data;

  const highResType = process.env.IMAGE_STORAGE_KEY_HIGHRES || "highres";
  const originalType = process.env.IMAGE_STORAGE_KEY_ORIGINAL || "original";

  // 1) 解析 EXIF → creationDate、GPS信息、图片尺寸、方向、MIME类型
  let creationDate = null;
  let gpsLatitude = null;
  let gpsLongitude = null;
  let gpsAltitude = null;
  let gpsLocation = null; // 位置全文描述
  let country = null;
  let city = null;
  let widthPx = null;
  let heightPx = null;
  let aspectRatio = null;
  let rawOrientation = null;
  let layoutType = null;
  let mime = null;

  // 时间分组相关变量
  let monthKey = null;
  let yearKey = null;
  let dateKey = null;
  let dayKey = null;

  // 高清图相关变量
  let highResStorageKeyResult = null; // 只有成功处理时才设置高清图存储键
  let hdWidthPx = null;
  let hdHeightPx = null;

  // 通过存储服务获取文件数据进行 EXIF 读取
  try {
    const fileData = await storageService.storage.getFileData(storageKey);
    const exifData = await extractImageMetadata(fileData);

    // 图片拍摄时间戳
    // extractImageMetadata 已经返回时间戳格式
    creationDate = exifData?.captureTime || null;

    // MIME类型提取
    mime = exifData?.mime || null;

    // 图片尺寸、图片横竖以及宽高比提取
    if (exifData?.width && exifData?.height) {
      const originalWidth = exifData.width;
      const originalHeight = exifData.height;
      rawOrientation = exifData.orientation || 1; // 默认为1（正常方向）

      // 根据 orientation 计算实际显示尺寸和方向分类
      const displayInfo = calculateOrientationInfo(originalWidth, originalHeight, rawOrientation);

      // 存储旋正后的尺寸
      widthPx = displayInfo.displayWidth;
      heightPx = displayInfo.displayHeight;
      layoutType = displayInfo.layoutType;
      aspectRatio = displayInfo.aspectRatio;
    }

    // GPS 信息提取
    if (exifData?.latitude && exifData?.longitude) {
      gpsLatitude = exifData.latitude;
      gpsLongitude = exifData.longitude;
      gpsAltitude = exifData.altitude || null;

      // 尝试获取位置描述
      try {
        const locationObj = await getLocationFromCoordinates(gpsLatitude, gpsLongitude);
        if (locationObj) {
          gpsLocation = locationObj.formattedAddress || null;
          country = locationObj.country || null;
          city = locationObj.city || null;
        }
      } catch (error) {
        logger.warn({
          message: "逆地理编码失败，继续处理图片",
          details: {
            imageHash,
            userId,
            gpsLatitude,
            gpsLongitude,
            error: error.message,
          },
        });
      }
    }
  } catch (err) {
    // EXIF 读取失败
    logger.error({
      message: "EXIF read failed in imageMetaIngestor",
      details: { imageHash, userId, storageKey, err },
    });

    // 处理重试失败逻辑
    await handleMetaRetryFailure({
      job,
      reason: "exif_read_failed",
      storageKey,
      fileName,
      imageHash,
      userId,
    });

    throw err;
  }

  monthKey = timestampToYearMonth(creationDate);
  yearKey = timestampToYear(creationDate);
  dateKey = timestampToDate(creationDate);
  dayKey = timestampToDayOfWeek(creationDate);

  // 使用存储服务生成高清图片的存储键名
  const highResStorageKey = storageService.storage.generateStorageKey(highResType, fileName, extension);

  // 生成压缩高清图
  try {
    const hdResult = await timeIt(
      "processAndStoreImage",
      async () => {
        return await storageService.processAndStoreImage({
          fileSize,
          sourceStorageKey: storageKey,
          targetStorageKey: highResStorageKey,
          extension,
          quality: 65, // avif建议 缩略图50-60 高清图60-70
          // resizeWidth: 2560,
          resizeWidth: 2048,
        });
      },
      imageHash,
    );

    // 高清图处理成功，设置存储键和实际尺寸
    highResStorageKeyResult = highResStorageKey;
    hdWidthPx = hdResult.width;
    hdHeightPx = hdResult.height;
  } catch (e) {
    // 高清图生成失败
    logger.error({
      message: "Generate HQ image failed",
      details: { imageHash, userId, highResStorageKey, err: String(e) },
    });

    // 处理重试失败逻辑
    await handleMetaRetryFailure({
      job,
      reason: "highres_generation_failed",
      storageKey,
      fileName,
      imageHash,
      userId,
    });

    throw e;
  }

  // 生成原图的存储键名（不传extension，直接使用fileName）
  const originalStorageKey = storageService.storage.generateStorageKey(originalType, fileName);
  // 更新数据库
  try {
    await updateImageMetaAndHQ({
      userId,
      imageHash,
      creationDate,
      monthKey,
      yearKey,
      dateKey,
      dayKey,
      highResStorageKey: highResStorageKeyResult, // 只有高清图处理成功时才不为null
      originalStorageKey,
      gpsLatitude,
      gpsLongitude,
      gpsAltitude,
      gpsLocation, // 使用逆地理编码获取的位置描述
      country,
      city,
      widthPx,
      heightPx,
      aspectRatio,
      rawOrientation,
      layoutType,
      hdWidthPx,
      hdHeightPx,
      mime,
    });
  } catch (e) {
    // 数据库更新失败
    logger.error({
      message: "Database update failed - EXIF metadata and high-res image info could not be saved",
      details: { imageHash, userId, err: String(e) },
    });

    // 处理重试失败逻辑
    await handleMetaRetryFailure({
      job,
      reason: "database_update_failed",
      storageKey,
      fileName,
      imageHash,
      userId,
      highResStorageKey: highResStorageKeyResult, // 数据库更新失败时，需要清理已生成的高清图
    });

    throw e;
  }
  try {
    if (sessionId) {
      await updateProgress({
        sessionId,
        status: "highResDone",
      });
    }
  } catch (err) {}
  // ======== 移动原图到 original 存储位置 ========
  try {
    await storageService.storage.moveFile(storageKey, originalStorageKey);
  } catch (e) {
    // 原图移动失败 - 非致命错误，不影响核心功能
    logger.warn({
      message: "Original file move failed - file remains in temporary location",
      details: {
        imageHash,
        userId,
        sourceStorageKey: storageKey,
        targetStorageKey: originalStorageKey,
        error: e.message,
        note: "This does not affect image functionality, manual cleanup may be needed",
      },
    });

    // 不抛出错误，让任务正常完成
  }
}

module.exports = {
  processImageMeta,
};
