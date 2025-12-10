/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类API控制器
 */

const faceClusterService = require("../services/faceClusterService");
const {
  getClustersByUserId,
  updateClusterName,
  removeFacesFromCluster,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
} = require("../models/faceClusterModel");
const { addFullUrlToImage, getGroupsByYearForCluster, getGroupsByMonthForCluster } = require("../services/imageService");
const logger = require("../utils/logger");

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
 * 获取用户的聚类列表（带分页、封面、时间范围）
 * GET /face-clusters?pageNo=1&pageSize=20
 */
async function getClusters(req, res, next) {
  try {
    const { userId } = req.user;
    const { pageNo = 1, pageSize = 20 } = req.query;

    // 添加调试日志：记录查询参数
    logger.info({
      message: "查询人物列表",
      details: {
        userId,
        pageNo: parseInt(pageNo),
        pageSize: parseInt(pageSize),
      },
    });

    const result = getClustersByUserId(userId, {
      pageNo: parseInt(pageNo),
      pageSize: parseInt(pageSize),
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
        storageType: cluster.coverImage.storageType || "aliyun-oss",
      }));

    const urlsMap = new Map();
    if (coverImages.length > 0) {
      // 先保存 thumbnailStorageKey 的映射关系（因为 addFullUrlToImage 会删除这个字段）
      const keyToIndexMap = new Map();
      coverImages.forEach((img, index) => {
        keyToIndexMap.set(index, img.thumbnailStorageKey);
      });

      const urls = await addFullUrlToImage(coverImages);

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
        pageNo: parseInt(pageNo),
        pageSize: parseInt(pageSize),
      },
    });
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
      return res.status(400).sendResponse({
        error: "名称必须是字符串或 null",
      });
    }

    const result = updateClusterName(userId, parseInt(clusterId), name || null);

    if (result.affectedRows === 0) {
      return res.status(404).sendResponse({
        error: "聚类不存在",
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
      return res.status(400).sendResponse({
        error: "faceEmbeddingIds 必须是非空数组",
      });
    }

    // 验证所有 faceEmbeddingIds 都是数字
    const invalidIds = faceEmbeddingIds.filter((id) => typeof id !== "number" && !Number.isInteger(Number(id)));
    if (invalidIds.length > 0) {
      return res.status(400).sendResponse({
        error: "faceEmbeddingIds 必须都是数字",
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
      return res.status(400).sendResponse({
        error: "faceEmbeddingIds 必须是非空数组",
      });
    }

    // 验证所有 faceEmbeddingIds 都是数字
    const invalidIds = faceEmbeddingIds.filter((id) => typeof id !== "number" && !Number.isInteger(Number(id)));
    if (invalidIds.length > 0) {
      return res.status(400).sendResponse({
        error: "faceEmbeddingIds 必须都是数字",
      });
    }

    // 如果提供了 targetClusterId，验证它是数字
    if (targetClusterId !== null && targetClusterId !== undefined) {
      if (typeof targetClusterId !== "number" && !Number.isInteger(Number(targetClusterId))) {
        return res.status(400).sendResponse({
          error: "targetClusterId 必须是数字或 null",
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
        pageNo: parseInt(pageNo),
        pageSize: parseInt(pageSize),
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
        pageNo: parseInt(pageNo),
        pageSize: parseInt(pageSize),
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
      return res.status(400).sendResponse({
        error: "clusterId 必须是数字",
      });
    }

    // 恢复默认封面
    const result = await faceClusterService.restoreDefaultCover(userId, clusterIdNum);

    if (!result) {
      return res.status(404).sendResponse({
        error: "恢复默认封面失败，请检查聚类是否存在",
      });
    }

    // 获取更新后的封面 URL
    let coverImageUrl = null;
    if (result.thumbnailStorageKey) {
      try {
        // 从 images 表获取 storage_type
        const { getFaceEmbeddingsByIds } = require("../models/faceClusterModel");
        const { getImageStorageInfo } = require("../models/imageModel");
        const storageService = require("../services/storageService");

        const faceEmbeddings = getFaceEmbeddingsByIds([result.faceEmbeddingId]);
        if (faceEmbeddings.length > 0) {
          const imageInfo = getImageStorageInfo(faceEmbeddings[0].image_id);
          const storageType = imageInfo?.storageType || "aliyun-oss";
          coverImageUrl = await storageService.getFileUrl(result.thumbnailStorageKey, storageType);
        }
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
      return res.status(400).sendResponse({
        error: "faceEmbeddingId 是必需的",
      });
    }

    // 验证 faceEmbeddingId 是否为数字
    const faceEmbeddingIdNum = parseInt(faceEmbeddingId);
    if (isNaN(faceEmbeddingIdNum)) {
      return res.status(400).sendResponse({
        error: "faceEmbeddingId 必须是数字",
      });
    }

    const clusterIdNum = parseInt(clusterId);
    if (isNaN(clusterIdNum)) {
      return res.status(400).sendResponse({
        error: "clusterId 必须是数字",
      });
    }

    // 验证 faceEmbeddingId 是否属于该 clusterId
    if (!verifyFaceEmbeddingInCluster(userId, clusterIdNum, faceEmbeddingIdNum)) {
      return res.status(400).sendResponse({
        error: "该 faceEmbeddingId 不属于该聚类",
      });
    }

    // 1. 生成缩略图（如果还没有）
    const thumbnailStorageKey = await faceClusterService.generateThumbnailForFaceEmbedding(faceEmbeddingIdNum);
    if (!thumbnailStorageKey) {
      logger.warn({
        message: `生成缩略图失败，但继续设置封面: faceEmbeddingId=${faceEmbeddingIdNum}`,
        details: { userId, clusterId: clusterIdNum },
      });
    }

    // 2. 设置封面（更新 is_representative）
    const result = setClusterCover(userId, clusterIdNum, faceEmbeddingIdNum);

    if (result.error) {
      return res.status(400).sendResponse({
        error: result.error,
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).sendResponse({
        error: "设置封面失败，请检查参数",
      });
    }

    // 3. 获取更新后的封面 URL
    let coverImageUrl = null;
    if (thumbnailStorageKey) {
      try {
        // 从 images 表获取 storage_type
        const { getFaceEmbeddingsByIds } = require("../models/faceClusterModel");
        const { getImageStorageInfo } = require("../models/imageModel");
        const storageService = require("../services/storageService");

        const faceEmbeddings = getFaceEmbeddingsByIds([faceEmbeddingIdNum]);
        if (faceEmbeddings.length > 0) {
          const imageInfo = getImageStorageInfo(faceEmbeddings[0].image_id);
          const storageType = imageInfo?.storageType || "aliyun-oss";
          coverImageUrl = await storageService.getFileUrl(thumbnailStorageKey, storageType);
        }
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
  updateCluster,
  removeFaces,
  moveFaces,
  getClusterYearAlbums,
  getClusterMonthAlbums,
  setClusterCoverImage,
  restoreClusterCoverImage,
};
