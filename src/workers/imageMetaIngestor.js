/*
 * @Author: zhangshouchang
 * @Date: 2025-08-31
 * @Description: meta 阶段（EXIF + 高清产物 + DB 补充）的独立处理器
 */

const logger = require("../utils/logger");
const { saveProcessedImageMetadata, setImageIngestStatus } = require("../services/imageService");
const { timestampToYearMonth, timestampToYear, timestampToDate, timestampToDayOfWeek } = require("../utils/formatTime");
const timeIt = require("../utils/timeIt");
const storageService = require("../services/storageService");
const videoProcessingService = require("../services/videoProcessingService");
const { updateProgress, updateProgressOnce } = require("../services/imageProcessingProgressService");
const { searchIndexQueue } = require("../queues/searchIndexQueue");
const { cleanupQueue } = require("../queues/cleanupQueue");
const imageMetadataService = require("../services/imageMetadataService");
const { addMediaToSession } = require("../services/uploadSessionService");

/**
 * 处理重试失败后的清理工作（用于imageMetaIngestor）
 * @param {Object} params - 参数对象
 * @param {Object} params.job - BullMQ job对象
 * @param {string} params.reason - 失败原因
 * @param {string} params.fileName - 文件名
 * @param {string} params.imageHash - 图片哈希
 * @param {string} params.userId - 用户ID
 * @param {string} [params.highResStorageKey] - 高清图存储键（可选）
 */
async function _handleMetaRetryFailure({ job, reason, fileName, imageHash, userId, highResStorageKey }) {
  const maxAttempts = job?.opts?.attempts || Number(process.env.IMAGE_META_JOB_ATTEMPTS || 5);
  const attemptsMade = job?.attemptsMade || 0;
  // 修复：判断失败后 BullMQ 是否还会重试
  // BullMQ 会在失败后将 attemptsMade 递增，然后判断是否 < maxAttempts
  // 我们需要预测递增后的判断结果：(attemptsMade + 1) < maxAttempts
  // 例如：第5次失败时 attemptsMade = 4 → (4+1) < 5 = false → 不会重试
  const willRetry = attemptsMade + 1 < maxAttempts;

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

    await setImageIngestStatus({
      userId,
      imageHash,
      ingestStatus: "failed",
    });
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
}

/**
 * 处理视频的 meta 阶段：ffprobe 元数据、移动原片、入队 AI 阶段
 */
async function processVideoMeta(job, { userId, imageHash, fileName, storageKey, originalStorageKey, sessionId }) {
  let videoPath;
  try {
    videoPath = await storageService.storage.getFileData(storageKey);
  } catch (err) {
    await _handleMetaRetryFailure({ job, reason: "file_read_failed", fileName, imageHash, userId });
    throw err;
  }

  let meta;
  try {
    meta = await videoProcessingService.getVideoMetadata(videoPath);
  } catch (err) {
    await _handleMetaRetryFailure({ job, reason: "metadata_analysis_failed", fileName, imageHash, userId });
    throw err;
  }

  const captureTime = meta.creationTime || undefined;
  const monthKey = timestampToYearMonth(captureTime);
  const yearKey = timestampToYear(captureTime);
  const dateKey = timestampToDate(captureTime);
  const dayKey = timestampToDayOfWeek(captureTime);

  let gpsLocation = null;
  let country = null;
  let city = null;
  if (meta.gpsLatitude != null && meta.gpsLongitude != null) {
    try {
      const locInfo = await imageMetadataService.analyzeLocationInfo(meta.gpsLatitude, meta.gpsLongitude);
      gpsLocation = locInfo?.gpsLocation || null;
      country = locInfo?.country || null;
      city = locInfo?.city || null;
    } catch (e) {
      logger.warn({ message: "Video GPS reverse geocode failed", details: { imageHash, error: e.message } });
    }
  }

  const aspectRatio =
    meta.width && meta.height && meta.height > 0 ? Math.round((meta.width / meta.height) * 1000) / 1000 : null;

  let imageId = null;
  try {
    const result = await saveProcessedImageMetadata({
      userId,
      imageHash,
      creationDate: captureTime,
      monthKey,
      yearKey,
      dateKey,
      dayKey,
      highResStorageKey: null,
      originalStorageKey,
      gpsLatitude: meta.gpsLatitude,
      gpsLongitude: meta.gpsLongitude,
      gpsLocation,
      country,
      city,
      widthPx: meta.width,
      heightPx: meta.height,
      aspectRatio,
      durationSec: meta.duration,
      videoCodec: meta.codec,
      mediaType: "video",
    });
    imageId = result.imageId;
  } catch (e) {
    logger.error({
      message: "Video metadata database update failed",
      details: { imageHash, userId, err: e.message },
    });
    throw e;
  }

  if (sessionId) {
    try {
      await updateProgress({ sessionId, status: "highResDone" });
    } catch (err) {}
  }

  if (sessionId && imageId) {
    try {
      await addMediaToSession({ sessionId, mediaId: imageId });
    } catch (error) {}
  }

  try {
    await storageService.storage.moveFile(storageKey, originalStorageKey);
  } catch (e) {
    logger.warn({
      message: "Video original file move failed",
      details: { imageHash, userId, sourceStorageKey: storageKey, targetStorageKey: originalStorageKey, error: e.message },
    });
  }

  await _enqueueAiAndCleanup({
    imageId,
    userId,
    highResStorageKey: null,
    originalStorageKey,
    sessionId,
    mediaType: "video",
    fileName,
    imageHash,
  });
}

async function _enqueueAiAndCleanup({ imageId, userId, highResStorageKey, originalStorageKey, sessionId, mediaType, fileName, imageHash }) {
  const enableAutoEnqueue = process.env.ENABLE_AUTO_AI_ENQUEUE !== "false"; // 默认启用

  if (!enableAutoEnqueue) {
    logger.info({
      message: "自动AI分析入队已禁用，请使用 scripts/development/enqueue-ai-analysis.js 手动触发",
      details: { imageHash, userId, imageId },
    });
    return;
  }

  if (!imageId) {
    logger.warn({
      message: "Cannot add to queues - imageId is null",
      details: { imageHash, userId },
    });
    return;
  }

  try {
    await searchIndexQueue.add(
      process.env.SEARCH_INDEX_QUEUE_NAME,
      {
        imageId,
        userId,
        highResStorageKey,
        originalStorageKey,
        sessionId,
        mediaType: mediaType || "image",
        fileName: fileName || "",
      },
      {
        jobId: `${userId}:${imageId}`,
      },
    );

    if (sessionId) {
      await updateProgressOnce({
        sessionId,
        status: "aiEligibleCount",
        dedupeKey: imageId,
      });
      await updateProgressOnce({
        sessionId,
        status: "aiQueuedCount",
        dedupeKey: imageId,
      });
    }
  } catch (searchQueueError) {
    logger.warn({
      message: "Failed to add image to search index queue",
      details: {
        imageHash,
        userId,
        error: searchQueueError.message,
      },
    });
  }

  try {
    await cleanupQueue.add(
      process.env.CLEANUP_QUEUE_NAME,
      {
        userId,
        imageId,
        highResStorageKey,
        originalStorageKey,
      },
      { jobId: `cleanup:${userId}:${imageId}` },
    );
  } catch (cleanupQueueError) {
    logger.warn({
      message: "Failed to add image to cleanup queue",
      details: {
        imageHash,
        userId,
        error: cleanupQueueError.message,
      },
    });
  }
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
  const { userId, imageHash, fileName, storageKey, extension, fileSize, sessionId, mediaType = "image" } = job.data;

  await setImageIngestStatus({
    userId,
    imageHash,
    ingestStatus: "processing",
  });

  const originalType = process.env.IMAGE_STORAGE_KEY_ORIGINAL || "original";
  const originalStorageKey = storageService.storage.generateStorageKey(originalType, fileName);

  // ========== 视频分支：ffprobe 元数据，不生成 highres，不入队 AI ==========
  if (mediaType === "video") {
    return processVideoMeta(job, {
      userId,
      imageHash,
      fileName,
      storageKey,
      originalStorageKey,
      sessionId,
    });
  }

  // ========== 图片分支：沿用现有逻辑 ==========
  const highResType = process.env.IMAGE_STORAGE_KEY_HIGHRES || "highres";
  let highResStorageKeyResult = null;
  let hdWidthPx = null;
  let hdHeightPx = null;

  let fileData = null;
  try {
    fileData = await storageService.storage.getFileData(storageKey);
  } catch (err) {
    await _handleMetaRetryFailure({ job, reason: "file_read_failed", fileName, imageHash, userId });
    throw err;
  }

  let metadata = null;
  try {
    metadata = await imageMetadataService.analyzeImageMetadata(fileData, {
      includeLocation: true,
    });
  } catch (err) {
    await _handleMetaRetryFailure({ job, reason: "metadata_analysis_failed", fileName, imageHash, userId });
    throw err;
  }

  const {
    captureTime,
    latitude,
    longitude,
    altitude,
    gpsLocation,
    country,
    city,
    width,
    height,
    aspectRatio,
    orientation,
    layoutType,
    mime,
  } = metadata;

  const monthKey = timestampToYearMonth(captureTime);
  const yearKey = timestampToYear(captureTime);
  const dateKey = timestampToDate(captureTime);
  const dayKey = timestampToDayOfWeek(captureTime);

  const highResStorageKey = storageService.storage.generateStorageKey(highResType, fileName, extension);

  try {
    const hdResult = await timeIt(
      "processAndStoreImage",
      async () => {
        return await storageService.processAndStoreImage({
          fileSize,
          sourceStorageKey: storageKey,
          targetStorageKey: highResStorageKey,
          extension,
          quality: 65,
          resizeWidth: 2048,
        });
      },
      imageHash,
    );

    highResStorageKeyResult = highResStorageKey;
    hdWidthPx = hdResult.width;
    hdHeightPx = hdResult.height;
  } catch (e) {
    logger.error({
      message: "Generate HQ image failed",
      details: { imageHash, userId, highResStorageKey, err: String(e) },
    });

    await _handleMetaRetryFailure({
      job,
      reason: "highres_generation_failed",
      fileName,
      imageHash,
      userId,
      highResStorageKey: highResStorageKeyResult,
    });

    throw e;
  }

  let imageId = null;
  try {
    const result = await saveProcessedImageMetadata({
      userId,
      imageHash,
      creationDate: captureTime,
      monthKey,
      yearKey,
      dateKey,
      dayKey,
      highResStorageKey: highResStorageKeyResult,
      originalStorageKey,
      gpsLatitude: latitude,
      gpsLongitude: longitude,
      gpsAltitude: altitude,
      gpsLocation,
      country,
      city,
      widthPx: width,
      heightPx: height,
      aspectRatio,
      rawOrientation: orientation,
      layoutType,
      hdWidthPx,
      hdHeightPx,
      mime,
    });
    imageId = result.imageId;
  } catch (e) {
    // 数据库更新失败
    logger.error({
      message: "Database update failed - EXIF metadata and high-res image info could not be saved",
      details: { imageHash, userId, err: String(e) },
    });

    // 处理重试失败逻辑
    await _handleMetaRetryFailure({
      job,
      reason: "database_update_failed",
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

  if (sessionId && imageId) {
    try {
      await addMediaToSession({ sessionId, mediaId: imageId });
    } catch (error) {}
  }

  await _enqueueAiAndCleanup({
    imageId,
    userId,
    highResStorageKey: highResStorageKeyResult,
    originalStorageKey,
    sessionId,
    mediaType: "image",
    fileName,
    imageHash,
  });
}

module.exports = {
  processImageMeta,
};
