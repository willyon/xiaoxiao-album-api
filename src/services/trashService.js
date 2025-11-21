/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 回收站业务逻辑层 - 处理已删除图片的查询、恢复、彻底删除等操作
 */

const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const trashModel = require("../models/trashModel");
const storageService = require("./storageService");
const StorageAdapterFactory = require("../storage/factory/StorageAdapterFactory");
const { STORAGE_TYPES } = require("../storage/constants/StorageTypes");
const LocalStorageAdapter = require("../storage/adapters/LocalStorageAdapter");
const AliyunOSSAdapter = require("../storage/adapters/AliyunOSSAdapter");
const { getStorageConfig } = require("../storage/constants/StorageTypes");
const logger = require("../utils/logger");

// 适配器缓存（按存储类型）
const adapterCache = {};

/**
 * 规范化ID列表
 * @param {Array} ids - ID数组
 * @returns {Array<number>} 规范化后的ID数组
 */
function _normalizeIdList(ids) {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    })
    .filter((value) => value !== null);
}

/**
 * 根据存储类型获取对应的适配器（带缓存）
 * @param {string} storageType - 存储类型 ('local' 或 'aliyun-oss')
 * @returns {Object} 存储适配器实例
 */
function _getAdapterByStorageType(storageType) {
  // 如果已有缓存的适配器，直接返回
  if (adapterCache[storageType]) {
    return adapterCache[storageType];
  }

  // 获取存储配置
  const storageConfig = getStorageConfig();
  let adapter;

  if (storageType === STORAGE_TYPES.LOCAL) {
    const options = storageConfig[STORAGE_TYPES.LOCAL] || {};
    adapter = new LocalStorageAdapter(options);
  } else if (storageType === STORAGE_TYPES.ALIYUN_OSS) {
    const ossConfig = storageConfig[STORAGE_TYPES.ALIYUN_OSS] || {};
    const authType = ossConfig.ossAuthType || "ecs_ram_role";
    const options = ossConfig[authType] || ossConfig;
    adapter = new AliyunOSSAdapter(options);
  } else {
    // 如果存储类型未知，使用当前配置的适配器
    logger.warn({
      message: "Unknown storage type, using default adapter",
      details: { storageType },
    });
    adapter = StorageAdapterFactory.createAdapter();
  }

  // 缓存适配器实例
  adapterCache[storageType] = adapter;
  return adapter;
}

/**
 * 删除单个图片的所有存储文件（thumbnail, high_res, original）
 * @param {Object} image - 图片信息对象
 * @param {string} image.storage_type - 存储类型
 * @param {string} [image.thumbnail_storage_key] - 缩略图存储键
 * @param {string} [image.high_res_storage_key] - 高清图存储键
 * @param {string} [image.original_storage_key] - 原图存储键
 * @returns {Promise<Array>} 删除结果数组
 */
async function _deleteImageFiles(image) {
  const { storage_type, thumbnail_storage_key, high_res_storage_key, original_storage_key } = image;

  // 收集所有需要删除的存储键
  const storageKeys = [];
  if (thumbnail_storage_key) storageKeys.push(thumbnail_storage_key);
  if (high_res_storage_key) storageKeys.push(high_res_storage_key);
  if (original_storage_key) storageKeys.push(original_storage_key);

  if (storageKeys.length === 0) {
    logger.info({
      message: "No storage keys to delete",
      details: { imageId: image.id },
    });
    return [];
  }

  // 根据存储类型获取对应的适配器
  const adapter = _getAdapterByStorageType(storage_type);

  // 删除文件
  const results = [];
  try {
    // OSS适配器支持批量删除，本地适配器需要循环删除
    if (storage_type === STORAGE_TYPES.ALIYUN_OSS && adapter.deleteFiles) {
      // OSS批量删除（最多1000个）
      const deleteResults = await adapter.deleteFiles(storageKeys);
      results.push(...deleteResults);
    } else {
      // 本地存储或其他情况，循环删除
      for (const key of storageKeys) {
        try {
          await adapter.deleteFile(key);
          results.push({ key, success: true });
        } catch (error) {
          logger.error({
            message: "Failed to delete file",
            details: { key, storageType: storage_type, error: error.message },
          });
          results.push({ key, success: false, error: error.message });
        }
      }
    }
  } catch (error) {
    logger.error({
      message: "Failed to delete image files",
      details: {
        imageId: image.id,
        storageType: storage_type,
        storageKeys,
        error: error.message,
      },
    });
    // 即使删除失败，也记录结果
    storageKeys.forEach((key) => {
      results.push({ key, success: false, error: error.message });
    });
  }

  return results;
}

/**
 * 批量删除图片的存储文件
 * @param {Array<Object>} images - 图片信息数组
 * @returns {Promise<Object>} 删除统计结果
 */
async function _deleteImagesFiles(images) {
  if (!images || images.length === 0) {
    return { total: 0, success: 0, failed: 0, details: [] };
  }

  // 按存储类型分组，以便批量处理
  const imagesByStorageType = {};
  images.forEach((image) => {
    const storageType = image.storage_type || STORAGE_TYPES.LOCAL;
    if (!imagesByStorageType[storageType]) {
      imagesByStorageType[storageType] = [];
    }
    imagesByStorageType[storageType].push(image);
  });

  const allResults = [];
  let totalFiles = 0;
  let successFiles = 0;
  let failedFiles = 0;

  // 按存储类型分别处理
  for (const [storageType, typeImages] of Object.entries(imagesByStorageType)) {
    const adapter = _getAdapterByStorageType(storageType);

    // 收集该类型下所有需要删除的存储键
    const allStorageKeys = [];
    const keyToImageMap = {}; // 用于追踪每个key属于哪个图片

    typeImages.forEach((image) => {
      const keys = [];
      if (image.thumbnail_storage_key) keys.push(image.thumbnail_storage_key);
      if (image.high_res_storage_key) keys.push(image.high_res_storage_key);
      if (image.original_storage_key) keys.push(image.original_storage_key);

      keys.forEach((key) => {
        allStorageKeys.push(key);
        if (!keyToImageMap[key]) {
          keyToImageMap[key] = [];
        }
        keyToImageMap[key].push(image.id);
      });
    });

    if (allStorageKeys.length === 0) continue;

    totalFiles += allStorageKeys.length;

    try {
      // OSS支持批量删除
      if (storageType === STORAGE_TYPES.ALIYUN_OSS && adapter.deleteFiles) {
        const deleteResults = await adapter.deleteFiles(allStorageKeys);
        deleteResults.forEach((result) => {
          allResults.push({
            imageIds: keyToImageMap[result.key] || [],
            key: result.key,
            success: result.success,
            error: result.error,
          });
          if (result.success) {
            successFiles++;
          } else {
            failedFiles++;
          }
        });
      } else {
        // 本地存储或其他情况，循环删除
        for (const key of allStorageKeys) {
          try {
            await adapter.deleteFile(key);
            allResults.push({
              imageIds: keyToImageMap[key] || [],
              key,
              success: true,
            });
            successFiles++;
          } catch (error) {
            logger.error({
              message: "Failed to delete file",
              details: { key, storageType, error: error.message },
            });
            allResults.push({
              imageIds: keyToImageMap[key] || [],
              key,
              success: false,
              error: error.message,
            });
            failedFiles++;
          }
        }
      }
    } catch (error) {
      logger.error({
        message: "Failed to delete files batch",
        details: { storageType, count: allStorageKeys.length, error: error.message },
      });
      // 标记所有文件为失败
      allStorageKeys.forEach((key) => {
        allResults.push({
          imageIds: keyToImageMap[key] || [],
          key,
          success: false,
          error: error.message,
        });
        failedFiles++;
      });
    }
  }

  return {
    total: totalFiles,
    success: successFiles,
    failed: failedFiles,
    details: allResults,
  };
}

/**
 * 获取回收站统计信息
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} 统计信息
 */
async function getTrashSummary(userId) {
  try {
    const total = trashModel.countDeletedImages(userId);
    return {
      total,
    };
  } catch (error) {
    logger.error({
      message: "Failed to get trash summary",
      details: { userId, error: error.message },
    });
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.INTERNAL_SERVER_ERROR,
      messageType: "error",
    });
  }
}

/**
 * 分页获取已删除图片列表
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {number} params.pageNo - 页码
 * @param {number} params.pageSize - 每页数量
 * @param {number} [params.cursor] - 游标
 * @returns {Promise<Object>} 图片列表和分页信息
 */
async function getDeletedImages({ userId, pageNo, pageSize }) {
  try {
    const result = trashModel.selectDeletedImagesByPage({
      userId,
      pageNo,
      pageSize,
    });

    // 生成图片URL并精简返回字段
    const list = await Promise.all(
      result.data.map(async (item) => {
        // 生成缩略图URL
        let thumbnailUrl = null;
        if (item.thumbnailStorageKey) {
          try {
            thumbnailUrl = await storageService.getFileUrl(item.thumbnailStorageKey, item.storageType);
          } catch (error) {
            logger.warn({
              message: "获取缩略图URL失败",
              details: {
                storageKey: item.thumbnailStorageKey,
                storageType: item.storageType,
                error: error.message,
              },
            });
          }
        }

        // 生成高清图URL
        let highResUrl = null;
        if (item.highResStorageKey) {
          try {
            highResUrl = await storageService.getFileUrl(item.highResStorageKey, item.storageType);
          } catch (error) {
            logger.warn({
              message: "获取高清图URL失败",
              details: {
                storageKey: item.highResStorageKey,
                storageType: item.storageType,
                error: error.message,
              },
            });
          }
        }

        // 返回精简后的字段（只包含前端需要的）
        return {
          imageId: item.imageId,
          thumbnailUrl,
          highResUrl,
          creationDate: item.creationDate,
          gpsLocation: item.gpsLocation,
          dayKey: item.dayKey,
          widthPx: item.widthPx,
          heightPx: item.heightPx,
          aspectRatio: item.aspectRatio,
          layoutType: item.layoutType,
          colorTheme: item.colorTheme,
          fileSizeBytes: item.fileSizeBytes,
        };
      }),
    );

    // 判断是否还有更多数据：通过比较已加载的数据量和总数
    const hasMore = list.length === pageSize && pageNo * pageSize < result.total;

    return {
      list,
      total: result.total,
      hasMore,
    };
  } catch (error) {
    logger.error({
      message: "Failed to get deleted images",
      details: { userId, pageNo, pageSize, error: error.message },
    });
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.INTERNAL_SERVER_ERROR,
      messageType: "error",
    });
  }
}

/**
 * 恢复图片（将 deleted_at 设为 NULL）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {Array<number>} params.imageIds - 图片ID数组
 * @returns {Promise<Object>} 恢复结果
 */
async function restoreImages({ userId, imageIds }) {
  const normalizedIds = _normalizeIdList(imageIds);

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  // 验证图片权限和状态
  const images = trashModel.selectDeletedImagesByIds(userId, normalizedIds);
  if (images.length !== normalizedIds.length) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "warning",
    });
  }

  const unauthorized = images.some((image) => image.user_id !== userId);
  if (unauthorized) {
    throw new CustomError({
      httpStatus: 403,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: "error",
    });
  }

  // 执行恢复操作
  const result = trashModel.restoreImages(normalizedIds);

  logger.info({
    message: "trash.restore.completed",
    details: {
      userId,
      imageIds: normalizedIds,
      restoredCount: result.changes,
    },
  });

  return {
    restoredCount: result.changes,
  };
}

/**
 * 彻底删除图片（物理删除数据库记录和存储文件）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {Array<number>} params.imageIds - 图片ID数组
 * @returns {Promise<Object>} 删除结果
 */
async function permanentlyDeleteImages({ userId, imageIds }) {
  const normalizedIds = _normalizeIdList(imageIds);

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  // 获取图片信息（用于删除文件）
  const images = trashModel.selectImagesForFileDeletion(userId, normalizedIds);
  if (images.length !== normalizedIds.length) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "warning",
    });
  }

  const unauthorized = images.some((image) => image.user_id !== userId);
  if (unauthorized) {
    throw new CustomError({
      httpStatus: 403,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: "error",
    });
  }

  // 删除存储文件（根据存储类型使用对应适配器）
  const fileDeleteResult = await _deleteImagesFiles(images);

  // 物理删除数据库记录
  const dbResult = trashModel.permanentlyDeleteImages(normalizedIds);

  logger.info({
    message: "trash.permanentlyDelete.completed",
    details: {
      userId,
      imageIds: normalizedIds,
      deletedCount: dbResult.changes,
      fileDeleteResult: {
        total: fileDeleteResult.total,
        success: fileDeleteResult.success,
        failed: fileDeleteResult.failed,
      },
    },
  });

  return {
    deletedCount: dbResult.changes,
    fileDeleteResult: {
      total: fileDeleteResult.total,
      success: fileDeleteResult.success,
      failed: fileDeleteResult.failed,
    },
  };
}

/**
 * 清空回收站（物理删除用户所有已删除图片）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @returns {Promise<Object>} 清空结果
 */
async function clearTrash({ userId }) {
  // 获取所有需要删除文件的图片信息
  const images = trashModel.selectTrashImagesForFileDeletion(userId);

  // 删除存储文件（根据存储类型使用对应适配器）
  const fileDeleteResult = await _deleteImagesFiles(images);

  // 物理删除数据库记录
  const dbResult = trashModel.clearTrash(userId);

  logger.info({
    message: "trash.clear.completed",
    details: {
      userId,
      deletedCount: dbResult.changes,
      fileDeleteResult: {
        total: fileDeleteResult.total,
        success: fileDeleteResult.success,
        failed: fileDeleteResult.failed,
      },
    },
  });

  return {
    deletedCount: dbResult.changes,
    fileDeleteResult: {
      total: fileDeleteResult.total,
      success: fileDeleteResult.success,
      failed: fileDeleteResult.failed,
    },
  };
}

module.exports = {
  getTrashSummary,
  getDeletedImages,
  restoreImages,
  permanentlyDeleteImages,
  clearTrash,
};
