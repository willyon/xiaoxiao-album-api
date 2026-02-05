/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册API控制器
 */
const albumService = require("../services/albumService");
const imageService = require("../services/imageService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const logger = require("../utils/logger");

/**
 * 创建相册
 */
async function createAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { name, description } = req.body;

    const album = await albumService.createAlbum({
      userId,
      name,
      description,
    });

    res.sendResponse({ data: album });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取相册详情
 */
async function getAlbumById(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;

    const album = await albumService.getAlbumById({
      albumId: parseInt(albumId),
      userId,
    });

    if (!album) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "error",
      });
    }

    res.sendResponse({ data: album });
  } catch (error) {
    next(error);
  }
}

/**
 * 更新相册
 */
async function updateAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    const { name, description, coverImageId } = req.body;

    const album = await albumService.updateAlbum({
      userId,
      albumId: parseInt(albumId),
      name,
      description,
      coverImageId: coverImageId ? parseInt(coverImageId) : undefined,
    });

    res.sendResponse({ data: album });
  } catch (error) {
    next(error);
  }
}

/**
 * 删除相册
 */
async function deleteAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;

    await albumService.deleteAlbum({
      userId,
      albumId: parseInt(albumId),
    });

    res.sendResponse({ data: { success: true } });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取自定义相册列表
 * GET /api/albums?pageNo=1&pageSize=20&search=xxx
 */
async function getCustomAlbums(req, res, next) {
  try {
    const userId = req.user.userId;
    const { pageNo, pageSize, search } = req.query;

    const result = await albumService.getAlbumsList({
      userId,
      pageNo: pageNo || 1,
      pageSize: pageSize || 20,
      search: search || null,
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 统一获取相册图片列表（year/month/date/custom）
 * GET /albums/:albumId/images?type=year&pageNo=1&pageSize=20&clusterId=123
 * 注意：type 参数必须提供，用于明确指定相册类型
 * clusterId 为可选参数，用于查询特定人物的相册照片
 */
async function queryAlbumPhotos(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    // GET 请求：type、clusterId 和分页参数都从 query 获取
    const { type, pageNo, pageSize, clusterId } = req.query;

    // 验证 type 参数
    if (!type || !["year", "month", "date", "custom", "location", "unknown"].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    let result;

    if (type === "custom") {
      // 自定义相册：albumId 是数字，暂不支持 clusterId 过滤
      result = await albumService.getAlbumImagesList({
        userId,
        albumId: parseInt(albumId),
        pageNo,
        pageSize,
      });
      res.sendResponse({ data: { list: result.list, total: result.total } });
    } else {
      // 时间相册（year/month/date）：albumId 是 year_key/month_key/date_key（字符串）
      // 支持可选的 clusterId 参数
      let queryResult;
      const clusterIdParam = clusterId ? parseInt(clusterId) : null;

      if (type === "year") {
        queryResult = await imageService.getImagesByYear({
          userId,
          pageNo,
          pageSize,
          albumId,
          clusterId: clusterIdParam,
        });
      } else if (type === "month") {
        queryResult = await imageService.getImagesByMonth({
          userId,
          pageNo,
          pageSize,
          albumId,
          clusterId: clusterIdParam,
        });
      } else if (type === "date") {
        queryResult = await imageService.getImagesByDate({ userId, pageNo, pageSize, albumId });
      } else if (type === "location") {
        queryResult = await imageService.getImagesByCity({ userId, pageNo, pageSize, albumId });
      } else if (type === "unknown") {
        queryResult = await imageService.getImagesByYear({
          userId,
          pageNo,
          pageSize,
          albumId: "unknown",
        });
      }

      // 为每条数据添加 albumId 字段（统一返回格式）
      const listWithAlbumId = queryResult.data.map((item) => ({
        ...item,
        albumId: albumId, // 将 year_key/month_key/date_key 作为 albumId 返回
      }));

      res.sendResponse({ data: { list: listWithAlbumId, total: queryResult.total } });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * 添加图片到相册（albumId 为数字相册 ID）
 */
async function addImagesToAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    const { imageIds } = req.body;

    const albumIdNum = parseInt(albumId, 10);
    if (Number.isNaN(albumIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const result = await albumService.addImagesToAlbum({
      userId,
      albumId: albumIdNum,
      imageIds: imageIds.map((id) => parseInt(id)),
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 从相册中移除图片（albumId 为数字相册 ID）
 */
async function removeImagesFromAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    const { imageIds } = req.body;

    const albumIdNum = parseInt(albumId, 10);
    if (Number.isNaN(albumIdNum)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const result = await albumService.removeImagesFromAlbum({
      userId,
      albumId: albumIdNum,
      imageIds: imageIds.map((id) => parseInt(id)),
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 设置相册封面图片
 */
async function setAlbumCover(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    const { imageId } = req.body;

    if (!imageId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const result = await albumService.setAlbumCover({
      userId,
      albumId: parseInt(albumId),
      imageId: parseInt(imageId),
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  getCustomAlbums,
  queryAlbumPhotos,
  addImagesToAlbum,
  removeImagesFromAlbum,
  setAlbumCover,
};
