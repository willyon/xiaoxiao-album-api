/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 回收站业务逻辑层 - 处理已删除图片的查询、恢复、彻底删除等操作
 */

const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const trashModel = require("../models/trashModel");
const albumModel = require("../models/albumModel");
const cleanupModel = require("../models/cleanupModel");
const mediaModel = require("../models/mediaModel");
const storageService = require("./storageService");
const logger = require("../utils/logger");
const { removeHashesFromUserSet } = require("../workers/userMediaHashset");

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

async function _removeRedisHashesForDeletedMedias(userId, images) {
  const hashes = (images || []).map((row) => row.file_hash).filter((h) => h != null && String(h).length > 0);
  if (hashes.length === 0) return;
  try {
    await removeHashesFromUserSet(userId, hashes);
  } catch (error) {
    logger.warn({
      message: "彻底删除媒体后清理 Redis 去重集合失败",
      details: { userId, hashCount: hashes.length, error: error.message },
    });
  }
}

/**
 * 批量删除图片的存储文件（使用当前环境配置的单一存储适配器）
 * @param {Array<Object>} images - 图片信息数组（含 thumbnail/high_res/original storage key）
 * @returns {Promise<Object>} 删除统计结果
 */
async function _deleteMediasFiles(images) {
  if (!images || images.length === 0) {
    return { total: 0, success: 0, failed: 0, details: [] };
  }

  const adapter = storageService.storage;
  const allStorageKeys = [];
  const keyToImageMap = {};

  images.forEach((image) => {
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

  if (allStorageKeys.length === 0) {
    return { total: 0, success: 0, failed: 0, details: [] };
  }

  const allResults = [];
  let successFiles = 0;
  let failedFiles = 0;
  const totalFiles = allStorageKeys.length;

  try {
    if (adapter.deleteFiles) {
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
            details: { key, error: error.message },
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
      details: { count: allStorageKeys.length, error: error.message },
    });
    allResults.length = 0;
    allStorageKeys.forEach((key) => {
      allResults.push({
        imageIds: keyToImageMap[key] || [],
        key,
        success: false,
        error: error.message,
      });
    });
    successFiles = 0;
    failedFiles = totalFiles;
  }

  return {
    total: totalFiles,
    success: successFiles,
    failed: failedFiles,
    details: allResults,
  };
}

/**
 * 分页获取已删除图片列表
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {number} params.pageNo - 页码
 * @param {number} params.pageSize - 每页数量
 * @param {string} [params.mediaType] - 媒体类型：'all' | 'image' | 'video'
 * @returns {Promise<{ list: Array, total: number }>} 图片列表与总数
 */
async function getDeletedMedias({ userId, pageNo, pageSize, mediaType }) {
  try {
    const result = trashModel.selectDeletedMediasByPage({
      userId,
      pageNo,
      pageSize,
      mediaType,
    });

    // 生成图片URL并精简返回字段
    const list = await Promise.all(
      result.data.map(async (item) => {
        // 生成缩略图URL
        let thumbnailUrl = null;
        if (item.thumbnailStorageKey) {
          try {
            thumbnailUrl = await storageService.getFileUrl(item.thumbnailStorageKey);
          } catch (error) {
            logger.warn({
              message: "获取缩略图URL失败",
              details: {
                storageKey: item.thumbnailStorageKey,
                error: error.message,
              },
            });
          }
        }

        // 生成高清图URL（图片有，视频无）
        let highResUrl = null;
        if (item.highResStorageKey) {
          try {
            highResUrl = await storageService.getFileUrl(item.highResStorageKey);
          } catch (error) {
            logger.warn({
              message: "获取高清图URL失败",
              details: {
                storageKey: item.highResStorageKey,
                error: error.message,
              },
            });
          }
        }

        // 视频需要 originalUrl
        let originalUrl = null;
        const needsOriginalUrl = item.mediaType === "video" || !item.highResStorageKey;
        if (needsOriginalUrl && item.originalStorageKey) {
          try {
            originalUrl = await storageService.getFileUrl(item.originalStorageKey);
          } catch (error) {
            logger.warn({
              message: "获取原片URL失败",
              details: {
                storageKey: item.originalStorageKey,
                error: error.message,
              },
            });
          }
        }

        // 返回精简后的字段（只包含前端需要的）
        return {
          mediaId: item.mediaId,
          mediaType: item.mediaType || "image",
          thumbnailUrl,
          highResUrl,
          originalUrl,
          isFavorite: item.isFavorite || false,
          capturedAt: item.capturedAt,
          gpsLocation: item.gpsLocation,
          dayKey: item.dayKey,
          widthPx: item.widthPx,
          heightPx: item.heightPx,
          aspectRatio: item.aspectRatio,
          layoutType: item.layoutType,
          fileSizeBytes: item.fileSizeBytes,
          durationSec: item.durationSec,
        };
      }),
    );

    return {
      list,
      total: result.total,
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
async function restoreMedias({ userId, imageIds }) {
  const normalizedIds = _normalizeIdList(imageIds);

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  // 验证图片权限和状态
  const images = trashModel.selectDeletedMediasByIds(userId, normalizedIds);
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
  const result = trashModel.restoreMedias(normalizedIds);

  // 恢复后重建 media_search 文档
  normalizedIds.forEach((id) => {
    try {
      mediaModel.rebuildMediaSearchDoc(id);
    } catch (error) {
      logger.warn({
        message: "恢复回收站媒体后同步搜索索引失败",
        details: { imageId: id, error: error.message },
      });
    }
  });

  // 更新包含这些图片的相册统计（图片数量、封面）
  albumModel.updateAlbumsStatsForMedias(normalizedIds);

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
 * 若该 hash 仅对应回收站中的媒体，则静默恢复（用于上传预检 / Worker 去重与恢复一致）
 * @returns {Promise<{ restored: boolean, mediaId?: number }>}
 */
async function restoreTrashMediaByHashIfApplicable({ userId, imageHash }) {
  const row = mediaModel.selectMediaRowByHashForUser({ userId, imageHash });
  if (!row || row.deleted_at == null) {
    return { restored: false };
  }
  await restoreMedias({ userId, imageIds: [row.id] });
  return { restored: true, mediaId: row.id };
}

/**
 * 彻底删除图片（物理删除数据库记录和存储文件）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {Array<number>} params.imageIds - 图片ID数组
 * @returns {Promise<Object>} 删除结果
 */
async function permanentlyDeleteMedias({ userId, imageIds }) {
  const normalizedIds = _normalizeIdList(imageIds);

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  // 获取图片信息（用于删除文件）
  const images = trashModel.selectMediasForFileDeletion(userId, normalizedIds);
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

  // 在物理删除之前，获取包含这些图片的相册和分组ID
  // 注意：需要在 CASCADE 删除之前获取ID
  const albumIds = albumModel.getAlbumsContainingMedias(normalizedIds);
  const groupIds = cleanupModel.getGroupsContainingMedias(normalizedIds);

  // 删除存储文件
  const fileDeleteResult = await _deleteMediasFiles(images);

  // 物理删除数据库记录（会触发 CASCADE 删除 album_media 和 similar_group_members）
  const dbResult = trashModel.permanentlyDeleteMedias(normalizedIds);

  // 更新相册统计（图片数量、封面）
  // 注意：album_media 已被 CASCADE 删除，所以需要更新相册统计
  if (albumIds.length > 0) {
    albumIds.forEach((albumId) => {
      albumModel.updateAlbumMediaCount(albumId);
      albumModel.updateAlbumCover(albumId);
    });
  }

  // 更新 cleanup 分组统计（member_count、primary_image_id）
  // 注意：similar_group_members 已被 CASCADE 删除，所以需要更新分组统计
  if (groupIds.length > 0) {
    const now = Date.now();
    groupIds.forEach((groupId) => {
      try {
        cleanupModel.refreshGroupStats(groupId, { updatedAt: now });
      } catch (error) {
        // 如果分组已被删除（refreshGroupStats 会删除空分组），忽略错误
        logger.warn({
          message: "更新 cleanup 分组统计失败",
          details: { groupId, error: error.message },
        });
      }
    });
  }

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
  const images = trashModel.selectTrashMediasForFileDeletion(userId);

  // 删除存储文件
  const fileDeleteResult = await _deleteMediasFiles(images);

  // 物理删除数据库记录
  const dbResult = trashModel.clearTrash(userId);

  await _removeRedisHashesForDeletedMedias(userId, images);

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
  getDeletedMedias,
  restoreMedias,
  restoreTrashMediaByHashIfApplicable,
  permanentlyDeleteMedias,
  clearTrash,
};
