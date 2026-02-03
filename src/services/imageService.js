/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 22:53:54
 * @Description: File description
 */
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const storageService = require("./storageService");
const imageModel = require("../models/imageModel");
const cleanupModel = require("../models/cleanupModel");
const albumModel = require("../models/albumModel");
const favoriteService = require("./favoriteService");
const exifr = require("exifr");
const exiftool = require("exiftool-vendored").exiftool;
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { stringToTimestamp } = require("../utils/formatTime");
const { getStandardMimeType } = require("../utils/fileUtils");
const sharp = require("sharp");
const { randomUUID } = require("crypto");

// EXIF Orientation 字符串 → 数值映射（exiftool 常见输出）
const ORIENTATION_MAP = {
  "Horizontal (normal)": 1,
  "Mirror horizontal": 2,
  "Rotate 180": 3,
  "Mirror vertical": 4,
  "Mirror horizontal and rotate 270 CW": 5,
  "Rotate 90 CW": 6,
  "Mirror horizontal and rotate 90 CW": 7,
  "Rotate 270 CW": 8,
};

// ========== 活跃的业务逻辑代码 ==========

// ========== URL处理工具函数 ==========

// 通用的URL添加方法
async function _addFullUrls(items, type = "image") {
  try {
    if (!items || !items.length) {
      return items;
    }

    // 根据类型选择处理逻辑
    if (type === "image") {
      // 处理图片：生成高清图片URL和缩略图URL
      for (const item of items) {
        if (item.highResStorageKey) {
          item.highResUrl = await storageService.getFileUrl(item.highResStorageKey, item.storageType);
          delete item.highResStorageKey; // 删除原始字段
        }
        if (item.thumbnailStorageKey) {
          item.thumbnailUrl = await storageService.getFileUrl(item.thumbnailStorageKey, item.storageType);
          delete item.thumbnailStorageKey; // 删除原始字段
        }
        // 删除 storageType 字段
        delete item.storageType;
      }
    } else if (type === "group") {
      // 处理分组：生成封面图片URL
      for (const item of items) {
        if (item.latestImagekey) {
          item.latestImageUrl = await storageService.getFileUrl(item.latestImagekey, item.storageType);
          delete item.latestImagekey; // 删除原始字段
        }
        // 删除 storageType 字段
        delete item.storageType;
      }
    }

    return items;
  } catch (error) {
    logger.error({
      message: `批量获取${type === "image" ? "图片" : "分组封面图片"}URL失败`,
      details: { error: error.message },
    });
  }
}

// 为图片数据添加完整URL的方法
// 注意：isFavorite 字段现在直接从数据库查询返回，无需额外处理
async function addFullUrlToImage(data) {
  return await _addFullUrls(data, "image");
}

// 为分组数据添加完整URL的方法
async function _addFullUrlToGroupCover(groups) {
  return await _addFullUrls(groups, "group");
}

// ========== 图片业务逻辑函数 ==========

// 保存新图片信息到数据库
async function saveNewImage(imageData) {
  // 参数校验
  const { userId, imageHash, thumbnailStorageKey } = imageData;
  if (!userId || !imageHash || !thumbnailStorageKey) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const result = await imageModel.insertImage(imageData);
    if (result.affectedRows === 0) {
      throw new CustomError({
        httpStatus: 500,
        messageCode: ERROR_CODES.DATA_INSERT_FAILED,
        messageType: "error",
      });
    }
    return result;
  } catch (error) {
    throw error;
  }
}

// 保存已处理的图片元数据（包含错误处理和日志记录）
async function saveProcessedImageMetadata(imageData) {
  try {
    const result = await imageModel.updateImageMetadata(imageData);
    return result;
  } catch (error) {
    logger.error({
      message: "更新图片元数据失败",
      details: { imageData, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "更新图片元数据失败");
  }
}

// 获取用户图片哈希列表
async function getUserImageHashes(userId) {
  try {
    const hashes = await imageModel.selectHashesByUserId(userId);
    return hashes;
  } catch (error) {
    logger.error({
      message: "获取用户图片哈希失败",
      details: { userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片哈希失败");
  }
}

// ========== 图片查询服务函数 ==========

/**
 * 分页获取用户模糊图列表（is_blurry = 1），用于清理页模糊图 tab
 * @returns {{ list: Array<{ imageId, thumbnailUrl, highResUrl, creationDate, createdAt, isFavorite }>, total: number }}
 */
async function getBlurryImages({ userId, pageNo = 1, pageSize = 20 }) {
  const safePageSize = Math.max(Number(pageSize) || 20, 1);
  const queryResult = imageModel.getImagesByBlurry({
    userId,
    pageNo,
    pageSize: safePageSize,
  });
  const total = queryResult.total;
  const list = await Promise.all(
    (queryResult.data || []).map(async (img) => {
      let thumbnailUrl = null;
      let highResUrl = null;
      if (img.thumbnailStorageKey != null) {
        try {
          thumbnailUrl = await storageService.getFileUrl(img.thumbnailStorageKey, img.storageType);
        } catch (e) {
          logger.warn({ message: "获取模糊图缩略图 URL 失败", details: { error: e?.message } });
        }
      }
      if (img.highResStorageKey != null) {
        try {
          highResUrl = await storageService.getFileUrl(img.highResStorageKey, img.storageType);
        } catch (e) {
          logger.warn({ message: "获取模糊图高清 URL 失败", details: { error: e?.message } });
        }
      }
      return {
        imageId: img.imageId,
        thumbnailUrl,
        highResUrl,
        creationDate: img.creationDate,
        createdAt: img.createdAt,
        isFavorite: img.isFavorite,
      };
    }),
  );
  return { list, total };
}

// 分页获取用户某年份图片
// albumId: 对于时间相册，实际上是 year_key (如 "2024")
// clusterId: 可选，用于查询特定人物的某年份照片
async function getImagesByYear({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  try {
    const result = await imageModel.selectImagesByYear({
      pageNo,
      pageSize,
      albumId,
      userId,
      clusterId,
    });

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某年份图片失败",
      details: { pageNo, pageSize, albumId, userId, clusterId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某月份图片
// albumId: 对于时间相册，实际上是 month_key (如 "2024-01")
// clusterId: 可选，用于查询特定人物的某月份照片
async function getImagesByMonth({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  try {
    const result = await imageModel.selectImagesByMonth({
      pageNo,
      pageSize,
      albumId,
      userId,
      clusterId,
    });

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某月份图片失败",
      details: { pageNo, pageSize, albumId, userId, clusterId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某日期图片
// albumId: 对于时间相册，实际上是 date_key (如 "2024-01-15")
async function getImagesByDate({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await imageModel.selectImagesByDate({ pageNo, pageSize, albumId, userId });

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某日期图片失败",
      details: { pageNo, pageSize, albumId, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某地点图片
// albumId: 城市名称或 'unknown'
async function getImagesByCity({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await imageModel.selectImagesByCity({ pageNo, pageSize, albumId, userId });

    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某地点图片失败",
      details: { pageNo, pageSize, albumId, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 按年份获取分组信息
async function getGroupsByYear({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByYear({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: "error",
    });
  }
}

// 按月份获取分组信息
async function getGroupsByMonth({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByMonth({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_MONTH,
      messageType: "error",
    });
  }
}

// 获取「未知时间」相册（单独查询，不混在年/月列表中）
async function getUnknownGroup({ userId, withFullUrls = true }) {
  try {
    const queryResult = await imageModel.selectUnknownGroup({ userId });
    if (withFullUrls && queryResult.data?.length) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }
    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: "error",
    });
  }
}

// 按地点获取分组信息
async function getGroupsByCity({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByCity({ pageNo, pageSize, userId });
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }
    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: "error",
    });
  }
}

// 按日期获取分组信息
async function getGroupsByDate({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByDate({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_DATE,
      messageType: "error",
    });
  }
}

// 按年份获取指定人物的分组信息
async function getGroupsByYearForCluster({ userId, clusterId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId || !clusterId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByYearForCluster({ pageNo, pageSize, userId, clusterId });

    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: "error",
    });
  }
}

// 按月份获取指定人物的分组信息
async function getGroupsByMonthForCluster({ userId, clusterId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId || !clusterId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByMonthForCluster({ pageNo, pageSize, userId, clusterId });

    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_MONTH,
      messageType: "error",
    });
  }
}

// 部分更新图片信息（仅用于 favorite 字段，更新 images.is_favorite）
async function patchImage({ userId, imageId, patchData }) {
  if (patchData.favorite !== undefined || patchData.isFavorite !== undefined) {
    const isFavorite = patchData.favorite !== undefined ? patchData.favorite : patchData.isFavorite;
    return await favoriteService.toggleFavoriteImage({
      userId,
      imageId,
      isFavorite,
    });
  }

  throw new CustomError({
    httpStatus: 400,
    messageCode: ERROR_CODES.INVALID_PARAMETERS,
    messageType: "warning",
    message: "目前只支持更新 favorite 字段",
  });
}

// 删除图片（软删除，移至回收站）
// 这是核心的删除方法，包含通用的删除逻辑
async function deleteImages({ userId, imageIds }) {
  // 规范化 ID 列表
  const normalizedIds = Array.isArray(imageIds) ? imageIds.map((id) => parseInt(id)).filter((id) => !isNaN(id)) : [];

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  // 验证图片权限
  const images = cleanupModel.selectImagesByIds(normalizedIds);
  if (images.length !== normalizedIds.length) {
    logger.warn({
      message: "删除图片时，部分图片未找到",
      details: {
        userId,
        requestedIds: normalizedIds,
        foundIds: images.map((img) => img.id),
        missingIds: normalizedIds.filter((id) => !images.some((img) => img.id === id)),
      },
    });
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "warning",
    });
  }

  // 验证用户权限
  const unauthorized = images.some((image) => image.user_id !== userId);
  if (unauthorized) {
    throw new CustomError({
      httpStatus: 403,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: "error",
    });
  }

  const now = Date.now();

  // 执行删除操作：软删除，标记 deleted_at
  cleanupModel.markImagesDeleted(normalizedIds, now);

  // 更新包含这些图片的相册统计（图片数量、封面）
  albumModel.updateAlbumsStatsForImages(normalizedIds);

  logger.info({
    message: "image.delete.completed",
    details: {
      userId,
      imageIds: normalizedIds,
      timestamp: now,
    },
  });

  return {
    deletedCount: normalizedIds.length,
  };
}

/**
 * 获取单张图片的下载信息
 */
async function getImageDownloadInfo({ userId, imageId }) {
  const image = imageModel.getImageDownloadInfo({ userId, imageId });
  if (!image) {
    return null;
  }
  return image;
}

/**
 * 批量获取图片的下载信息
 */
async function getImagesDownloadInfo({ userId, imageIds }) {
  const images = imageModel.getImagesDownloadInfo({ userId, imageIds });
  return images;
}

module.exports = {
  // ========== 图片业务逻辑函数 ==========
  saveNewImage,
  saveProcessedImageMetadata,
  getUserImageHashes,

  // ========== 图片查询服务函数 ==========
  getBlurryImages,
  getImagesByYear,
  getImagesByMonth,
  getImagesByDate,
  getImagesByCity,
  getGroupsByYear,
  getGroupsByMonth,
  getGroupsByDate,
  getUnknownGroup,
  getGroupsByCity,
  getGroupsByYearForCluster,
  getGroupsByMonthForCluster,
  addFullUrlToImage,

  // ========== 图片 CRUD 服务函数 ==========
  patchImage, // 仅用于 favorite 字段更新
  deleteImages,
  // ========== 图片下载服务函数 ==========
  getImageDownloadInfo,
  getImagesDownloadInfo,
};
