/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类API控制器
 */

const faceClusterService = require("../services/faceClusterService");
const {
  getClustersByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  removeFacesFromCluster,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdsByClusterId,
} = require("../models/faceClusterModel");
const { addFullUrlToMedia, getGroupsByYearForCluster, getGroupsByMonthForCluster } = require("../services/mediaService");
const storageService = require("../services/storageService");
const logger = require("../utils/logger");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");

/**
 * 获取聚类统计信息
 * GET /face-clusters/stats
 */
async function getClusterStats(req, res, next) {
  try {
    const { userId } = req.user;

    const stats = faceClusterService.getFaceClusterStats(userId);

    res.sendResponse({
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取指定人物（cluster）下所有 face_embedding_id（用于前端「合并到其他人」时一次性移整人）
 * GET /face-clusters/:clusterId/face-embedding-ids
 */
async function getClusterFaceEmbeddingIds(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;

    const clusterIdNum = parseInt(clusterId, 10);
    if (Number.isNaN(clusterIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const faceEmbeddingIds = getFaceEmbeddingIdsByClusterId(userId, clusterIdNum);

    res.sendResponse({
      data: { faceEmbeddingIds },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取用户的聚类列表（带分页、封面、时间范围）
 * GET /face-clusters?pageNo=1&pageSize=20
 */
async function getClusters(req, res, next) {
  try {
    const { userId } = req.user;
    const { pageNo = 1, pageSize = 20, search } = req.query;
    const searchVal = search && typeof search === "string" ? search.trim() || null : null;

    const result = getClustersByUserId(userId, {
      pageNo: parseInt(pageNo, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
      search: searchVal,
    });

    // 添加调试日志：记录查询结果
    logger.info({
      message: "人物列表查询结果",
      details: {
        userId,
        total: result.total,
        listLength: result.list?.length || 0,
        hasData: result.total > 0,
      },
    });

    // 批量处理封面图片 URL（优化：一次性处理所有图片，而不是逐个处理）
    const coverImages = result.list
      .filter((cluster) => cluster.coverImage?.thumbnailStorageKey)
      .map((cluster) => ({
        thumbnailStorageKey: cluster.coverImage.thumbnailStorageKey,
      }));

    const urlsMap = new Map();
    if (coverImages.length > 0) {
      // 先保存 thumbnailStorageKey 的映射关系（因为 addFullUrlToMedia 会删除这个字段）
      const keyToIndexMap = new Map();
      coverImages.forEach((img, index) => {
        keyToIndexMap.set(index, img.thumbnailStorageKey);
      });

      const urls = await addFullUrlToMedia(coverImages);

      // 使用保存的 key 来建立映射关系
      urls.forEach((urlItem, index) => {
        const originalKey = keyToIndexMap.get(index);
        if (originalKey && urlItem?.thumbnailUrl) {
          urlsMap.set(originalKey, urlItem.thumbnailUrl);
        }
      });
    }

    // 为每个聚类添加 URL，并只返回前端需要的字段
    const listWithUrls = result.list.map((cluster) => {
      const coverImageUrl = cluster.coverImage?.thumbnailStorageKey ? urlsMap.get(cluster.coverImage.thumbnailStorageKey) || null : null;

      return {
        clusterId: cluster.clusterId,
        name: cluster.name,
        imageCount: cluster.imageCount,
        coverImage: coverImageUrl ? { thumbnailUrl: coverImageUrl } : null,
        timeRange: cluster.timeRange,
      };
    });

    res.sendResponse({
      data: {
        list: listWithUrls,
        total: result.total,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取最近使用的人物列表（用于 popover 第一屏，排序：最近使用 > 有名字 > 图片数量）
 * GET /face-clusters/recent?limit=5&excludeClusterId=123
 */
async function getRecentClusters(req, res, next) {
  try {
    const { userId } = req.user;
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const excludeClusterId = req.query.excludeClusterId ? parseInt(req.query.excludeClusterId, 10) : null;

    const result = getRecentClustersByUserId(userId, {
      limit,
      excludeClusterId: Number.isNaN(excludeClusterId) ? null : excludeClusterId,
    });

    const coverImages = result.list
      .filter((cluster) => cluster.coverImage?.thumbnailStorageKey)
      .map((cluster) => ({
        thumbnailStorageKey: cluster.coverImage.thumbnailStorageKey,
      }));

    const urlsMap = new Map();
    if (coverImages.length > 0) {
      const keyToIndexMap = new Map();
      coverImages.forEach((img, index) => keyToIndexMap.set(index, img.thumbnailStorageKey));
      const urls = await addFullUrlToMedia(coverImages);
      urls.forEach((urlItem, index) => {
        const originalKey = keyToIndexMap.get(index);
        if (originalKey && urlItem?.thumbnailUrl) urlsMap.set(originalKey, urlItem.thumbnailUrl);
      });
    }

    const listWithUrls = result.list.map((cluster) => {
      const url = cluster.coverImage?.thumbnailStorageKey ? urlsMap.get(cluster.coverImage.thumbnailStorageKey) : null;
      return {
        clusterId: cluster.clusterId,
        name: cluster.name,
        imageCount: cluster.imageCount,
        coverImage: url ? { thumbnailUrl: url } : null,
        timeRange: cluster.timeRange,
      };
    });

    res.sendResponse({ data: { list: listWithUrls, total: result.total } });
  } catch (error) {
    next(error);
  }
}

/**
 * 更新聚类名称
 * PATCH /face-clusters/:clusterId
 */
async function updateCluster(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;
    const { name } = req.body;

    if (name !== undefined && typeof name !== "string" && name !== null) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const clusterIdNum = parseInt(clusterId);
    if (name != null && String(name).trim() !== "") {
      const existingNames = getExistingPersonNames(userId, clusterIdNum);
      if (existingNames.includes(String(name).trim())) {
        throw new CustomError({
          httpStatus: 400,
          messageCode: ERROR_CODES.DUPLICATE_PERSON_NAME,
          messageType: "warning",
        });
      }
    }

    const result = updateClusterName(userId, clusterIdNum, name || null);

    if (result.affectedRows === 0) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "error",
      });
    }

    res.sendResponse({
      data: {
        clusterId: parseInt(clusterId),
        name: name || null,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 从聚类中移除照片
 * DELETE /face-clusters/:clusterId/faces
 */
async function removeFaces(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;
    const { faceEmbeddingIds } = req.body;

    if (!Array.isArray(faceEmbeddingIds) || faceEmbeddingIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 验证所有 faceEmbeddingIds 都是数字
    const invalidIds = faceEmbeddingIds.filter((id) => typeof id !== "number" && !Number.isInteger(Number(id)));
    if (invalidIds.length > 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const result = removeFacesFromCluster(
      userId,
      parseInt(clusterId),
      faceEmbeddingIds.map((id) => parseInt(id)),
    );

    res.sendResponse({
      data: {
        affectedRows: result.affectedRows,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 将照片从一个聚类移动到另一个聚类（或创建新聚类）
 * POST /face-clusters/:clusterId/move-faces
 */
async function moveFaces(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;
    const { faceEmbeddingIds, targetClusterId, newClusterName } = req.body;

    if (!Array.isArray(faceEmbeddingIds) || faceEmbeddingIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 验证所有 faceEmbeddingIds 都是数字
    const invalidIds = faceEmbeddingIds.filter((id) => typeof id !== "number" && !Number.isInteger(Number(id)));
    if (invalidIds.length > 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 如果提供了 targetClusterId，验证它是数字
    if (targetClusterId !== null && targetClusterId !== undefined) {
      if (typeof targetClusterId !== "number" && !Number.isInteger(Number(targetClusterId))) {
        throw new CustomError({
          httpStatus: 400,
          messageCode: ERROR_CODES.INVALID_PARAMETERS,
          messageType: "error",
        });
      }
    }

    // 新建人物时校验名称是否与现有人物重名
    const newName = newClusterName != null ? String(newClusterName).trim() : "";
    if (targetClusterId == null && newName !== "") {
      const existingNames = getExistingPersonNames(userId, null);
      if (existingNames.includes(newName)) {
        throw new CustomError({
          httpStatus: 400,
          messageCode: ERROR_CODES.DUPLICATE_PERSON_NAME,
          messageType: "warning",
        });
      }
    }

    const result = moveFacesToCluster(
      userId,
      parseInt(clusterId),
      faceEmbeddingIds.map((id) => parseInt(id)),
      targetClusterId ? parseInt(targetClusterId) : null,
      newClusterName || null,
    );

    res.sendResponse({
      data: {
        affectedRows: result.affectedRows,
        targetClusterId: result.targetClusterId,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取指定人物的年份相册列表
 * GET /face-clusters/:clusterId/albums/year?pageNo=1&pageSize=20
 */
async function getClusterYearAlbums(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;
    const { pageNo = 1, pageSize = 20 } = req.query;

    const result = await getGroupsByYearForCluster({
      userId,
      clusterId: parseInt(clusterId),
      pageNo: parseInt(pageNo),
      pageSize: parseInt(pageSize),
    });

    res.sendResponse({
      data: {
        list: result.data,
        total: result.total,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取指定人物的月份相册列表
 * GET /face-clusters/:clusterId/albums/month?pageNo=1&pageSize=20
 */
async function getClusterMonthAlbums(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;
    const { pageNo = 1, pageSize = 20 } = req.query;

    const result = await getGroupsByMonthForCluster({
      userId,
      clusterId: parseInt(clusterId),
      pageNo: parseInt(pageNo),
      pageSize: parseInt(pageSize),
    });

    res.sendResponse({
      data: {
        list: result.data,
        total: result.total,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 恢复人物聚类默认封面
 * DELETE /face-clusters/:clusterId/cover
 */
async function restoreClusterCoverImage(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;

    const clusterIdNum = parseInt(clusterId);
    if (isNaN(clusterIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 恢复默认封面
    const result = await faceClusterService.restoreDefaultCover(userId, clusterIdNum);

    if (!result) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "error",
      });
    }

    // 获取更新后的封面 URL
    let coverImageUrl = null;
    if (result.thumbnailStorageKey) {
      try {
        coverImageUrl = await storageService.getFileUrl(result.thumbnailStorageKey);
      } catch (error) {
        logger.error({
          message: `获取封面URL失败: faceEmbeddingId=${result.faceEmbeddingId}`,
          details: { error: error.message },
        });
      }
    }

    res.sendResponse({
      data: {
        clusterId: clusterIdNum,
        faceEmbeddingId: result.faceEmbeddingId,
        coverImageUrl,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 设置人物聚类封面
 * PATCH /face-clusters/:clusterId/cover
 */
async function setClusterCoverImage(req, res, next) {
  try {
    const { userId } = req.user;
    const { clusterId } = req.params;
    const { faceEmbeddingId } = req.body;

    if (!faceEmbeddingId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 验证 faceEmbeddingId 是否为数字
    const faceEmbeddingIdNum = parseInt(faceEmbeddingId);
    if (isNaN(faceEmbeddingIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const clusterIdNum = parseInt(clusterId);
    if (isNaN(clusterIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 验证 faceEmbeddingId 是否属于该 clusterId
    if (!verifyFaceEmbeddingInCluster(userId, clusterIdNum, faceEmbeddingIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 1. 生成人脸缩略图（大头像裁剪图）；没有则无法设置为封面，必须用人脸图而非整张图
    const thumbnailStorageKey = await faceClusterService.generateThumbnailForFaceEmbedding(faceEmbeddingIdNum);
    if (!thumbnailStorageKey) {
      logger.warn({
        message: `无法生成人脸缩略图，拒绝设置封面: faceEmbeddingId=${faceEmbeddingIdNum}`,
        details: { userId, clusterId: clusterIdNum },
      });
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.PERSON_COVER_FACE_THUMBNAIL_UNAVAILABLE,
        messageType: "error",
      });
    }

    // 2. 设置封面（更新 is_representative，封面为人脸缩略图）
    const result = setClusterCover(userId, clusterIdNum, faceEmbeddingIdNum);

    if (result.error) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
        message: result.error,
      });
    }

    // setClusterCover 在「选中的就是当前默认封面」时有意返回 affectedRows=0（无需改库），此时 isDefaultCover=true，不应当作 404
    if (result.affectedRows === 0 && !result.isDefaultCover) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "error",
      });
    }

    // 3. 获取更新后的封面 URL
    let coverImageUrl = null;
    if (thumbnailStorageKey) {
      try {
        coverImageUrl = await storageService.getFileUrl(thumbnailStorageKey);
      } catch (error) {
        logger.error({
          message: `获取封面URL失败: faceEmbeddingId=${faceEmbeddingIdNum}`,
          details: { error: error.message },
        });
      }
    }

    res.sendResponse({
      data: {
        clusterId: clusterIdNum,
        faceEmbeddingId: faceEmbeddingIdNum,
        coverImageUrl,
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getClusterStats,
  getClusters,
  getRecentClusters,
  getClusterFaceEmbeddingIds,
  updateCluster,
  removeFaces,
  moveFaces,
  getClusterYearAlbums,
  getClusterMonthAlbums,
  setClusterCoverImage,
  restoreClusterCoverImage,
};
