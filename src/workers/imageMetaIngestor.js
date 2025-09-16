/*
 * @Author: zhangshouchang
 * @Date: 2025-08-31
 * @Description: meta 阶段（EXIF + 高清产物 + DB 补充）的独立处理器
 */

const path = require("path");
const logger = require("../utils/logger");
const { extractImageMetadata, updateImageMetaAndHQ } = require("../services/imageService");
const { timestampToYearMonth, timestampToYear } = require("../utils/formatTime");
const timeIt = require("../utils/timeIt");
const storageService = require("../services/storageService");
const { getLocationFromCoordinates } = require("../services/geocodingService");

/**
 * 处理单张图片的"后处理"：
 * 1) 读取 EXIF → creationDate/monthKey/yearKey
 * 2) 产出高清大图（默认 AVIF）
 * 3) 更新数据库（补 creationDate/monthKey/yearKey/highResUrl）
 * 4) 将原图移动至 original 存储位置
 *
 * @param {Object} payload
 * @param {number|string} payload.userId
 * @param {string} payload.imageHash
 * @param {string} payload.fileName
 * @param {string} payload.storageKey - 原始文件的存储键名
 * @param {string} [payload.extension]
 * @param {number} [payload.fileSize]
 */
async function processImageMeta(payload) {
  const { userId, imageHash, fileName, storageKey, extension, fileSize } = payload;

  // 1) 解析 EXIF → creationDate 和 GPS 信息
  let creationDate = null;
  let gpsLatitude = null;
  let gpsLongitude = null;
  let gpsAltitude = null;
  let gpsLocation = null; // 将gpsLocation声明移到外层作用域

  try {
    // 通过存储服务获取文件数据进行 EXIF 读取
    const fileData = await storageService.storage.getFileData(storageKey);
    const exifData = await extractImageMetadata(fileData);

    // 图片拍摄时间戳
    // extractImageMetadata 已经返回时间戳格式
    creationDate = exifData?.captureTime || null;

    // GPS 信息提取
    if (exifData?.latitude && exifData?.longitude) {
      gpsLatitude = exifData.latitude;
      gpsLongitude = exifData.longitude;
      gpsAltitude = exifData.altitude || null;

      // 尝试获取位置描述
      try {
        thumbnailUrl = await getLocationFromCoordinates(gpsLatitude, gpsLongitude);

        logger.info({
          message: "GPS信息提取成功",
          details: {
            imageHash,
            userId,
            gpsLatitude,
            gpsLongitude,
            gpsAltitude,
            gpsLocation: gpsLocation || "逆地理编码失败",
          },
        });
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
    // 非致命：没 EXIF 也可以走 unknown
    logger.warn({
      message: "EXIF read failed in imageMetaIngestor",
      details: { imageHash, userId, storageKey, err },
    });
  }

  const monthKey = timestampToYearMonth(creationDate);
  const yearKey = timestampToYear(creationDate);

  // 2) 产出高清大图（AVIF 默认）
  // 使用存储服务生成高清图片的存储键名
  const highResType = process.env.IMAGE_STORAGE_KEY_HIGHRES || "highres";
  const highResStorageKey = storageService.storage.generateStorageKey(highResType, fileName, extension);

  let highResStorageKeyResult = null; // 只有成功处理时才设置高清图存储键

  try {
    await timeIt(
      "processAndStoreImage",
      async () => {
        await storageService.processAndStoreImage({
          fileSize, // 传递文件大小，提升性能
          sourceStorageKey: storageKey,
          targetStorageKey: highResStorageKey,
          extension,
          quality: 65, // avif建议 缩略图50-60 高清图60-70
          resizeWidth: 2560,
        });
      },
      imageHash,
    );

    // 高清图处理成功，设置存储键
    highResStorageKeyResult = highResStorageKey;

    logger.info({
      message: "Generate HQ image successful",
      details: { imageHash, userId, highResStorageKey },
    });
  } catch (e) {
    // 高清失败也不算致命 → 记录警告，但不设置highResStorageKey
    logger.warn({
      message: "Generate HQ image failed",
      details: { imageHash, userId, highResStorageKey, err: String(e) },
    });
  }

  // 3) 更新数据库：补 creationDate / monthKey / yearKey / highResStorageKey
  // 生成原图的存储键名（不传extension，直接使用fileName）
  const originalType = process.env.IMAGE_STORAGE_KEY_ORIGINAL || "original";
  const originalStorageKey = storageService.storage.generateStorageKey(originalType, fileName);

  try {
    await updateImageMetaAndHQ({
      userId,
      imageHash,
      creationDate,
      monthKey,
      yearKey,
      highResStorageKey: highResStorageKeyResult, // 只有高清图处理成功时才不为null
      originalStorageKey,
      gpsLatitude,
      gpsLongitude,
      gpsAltitude,
      gpsLocation, // 使用逆地理编码获取的位置描述
    });
  } catch (e) {
    logger.error({
      message: "updateImageMetaAndHQ failed in imageMetaIngestor",
      details: { imageHash, userId, err: String(e) },
    });
  }
  // ======== 移动原图到 original 存储位置 ========
  try {
    await storageService.storage.moveFile(storageKey, originalStorageKey);

    logger.info({
      message: "Image metadata processing completed successfully",
      details: {
        imageHash,
        userId,
        fileName,
        originalStorageKey,
        highResStorageKey: highResStorageKey || null,
        creationDate: creationDate || null,
      },
    });
  } catch (e) {
    // 记录错误，不算致命
    // 移动文件失败不应该影响元数据更新，但需要记录警告
    // 原始文件仍在临时位置，可以通过后续脚本修复
    logger.warn({
      message: "Original file remains in temporary location due to move failure",
      details: {
        imageHash,
        userId,
      },
    });
  }
}

module.exports = {
  processImageMeta,
};
