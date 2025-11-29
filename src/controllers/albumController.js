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
      return next({
        httpStatus: 404,
        messageCode: "RESOURCE_NOT_FOUND",
        messageType: "error",
        message: "相册不存在",
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
 * 统一获取相册列表（year/month/date/custom）
 * POST /images/albums/:type
 * Body: { pageNo, pageSize }
 */
async function queryAlbums(req, res, next) {
  try {
    const userId = req.user.userId;
    const { type } = req.params;
    const { pageNo, pageSize } = req.body;

    if (!type || !["year", "month", "date", "custom"].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
        message: "无效的目录类型",
      });
    }

    let result;

    if (type === "custom") {
      // 自定义相册目录
      result = await albumService.getAlbumsList({
        userId,
        pageNo: pageNo || 1,
        pageSize: pageSize || 20,
      });
      res.sendResponse({ data: result });
    } else {
      // 时间相册目录（year/month/date）
      let queryResult;
      if (type === "year") {
        queryResult = await imageService.getGroupsByYear({ userId, pageNo: pageNo || 1, pageSize: pageSize || 20 });
      } else if (type === "month") {
        queryResult = await imageService.getGroupsByMonth({ userId, pageNo: pageNo || 1, pageSize: pageSize || 20 });
      } else if (type === "date") {
        queryResult = await imageService.getGroupsByDate({ userId, pageNo: pageNo || 1, pageSize: pageSize || 20 });
      }

      res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * 统一获取相册图片列表（year/month/date/custom）
 * POST /images/albums/:type/:albumId/photos
 * Body: { pageNo, pageSize }
 */
async function queryAlbumPhotos(req, res, next) {
  try {
    const userId = req.user.userId;
    const { type, albumId } = req.params;
    const { pageNo, pageSize } = req.body;

    if (!type || !["year", "month", "date", "custom"].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
        message: "无效的相册类型",
      });
    }

    let result;

    if (type === "custom") {
      // 自定义相册：albumId 是数字
      result = await albumService.getAlbumImagesList({
        userId,
        albumId: parseInt(albumId),
        pageNo,
        pageSize,
      });
      res.sendResponse({ data: { list: result.list, total: result.total } });
    } else {
      // 时间相册（year/month/date）：albumId 是 year_key/month_key/date_key（字符串）
      let queryResult;
      if (type === "year") {
        queryResult = await imageService.getImagesByYear({ userId, pageNo, pageSize, albumId });
      } else if (type === "month") {
        queryResult = await imageService.getImagesByMonth({ userId, pageNo, pageSize, albumId });
      } else if (type === "date") {
        queryResult = await imageService.getImagesByDate({ userId, pageNo, pageSize, albumId });
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
 * 添加图片到相册
 */
async function addImagesToAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    const { imageIds } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return next({
        httpStatus: 400,
        messageCode: "INVALID_PARAMETERS",
        messageType: "warning",
        message: "图片ID列表不能为空",
      });
    }

    const result = await albumService.addImagesToAlbum({
      userId,
      albumId: parseInt(albumId),
      imageIds: imageIds.map((id) => parseInt(id)),
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 从相册中移除图片
 */
async function removeImagesFromAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumId } = req.params;
    const { imageIds } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return next({
        httpStatus: 400,
        messageCode: "INVALID_PARAMETERS",
        messageType: "warning",
        message: "图片ID列表不能为空",
      });
    }

    const result = await albumService.removeImagesFromAlbum({
      userId,
      albumId: parseInt(albumId),
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
      return next({
        httpStatus: 400,
        messageCode: "INVALID_PARAMETERS",
        messageType: "warning",
        message: "图片ID不能为空",
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

/**
 * 切换图片喜欢状态
 */
async function toggleFavoriteImage(req, res, next) {
  try {
    const userId = req.user.userId;
    const { imageId, isFavorite } = req.body;

    if (!imageId || typeof isFavorite !== "boolean") {
      return next({
        httpStatus: 400,
        messageCode: "INVALID_PARAMETERS",
        messageType: "warning",
        message: "参数错误",
      });
    }

    const result = await albumService.toggleFavoriteImage({
      userId,
      imageId: parseInt(imageId),
      isFavorite,
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
  queryAlbums,
  queryAlbumPhotos,
  addImagesToAlbum,
  removeImagesFromAlbum,
  setAlbumCover,
  toggleFavoriteImage,
};
