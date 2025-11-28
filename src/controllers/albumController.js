/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册API控制器
 */
const albumService = require("../services/albumService");
const logger = require("../utils/logger");

/**
 * 获取用户的相册列表
 */
async function getAlbumsList(req, res, next) {
  try {
    const userId = req.user.userId;
    const { albumType, pageNo, pageSize } = req.query;

    const result = await albumService.getAlbumsList({
      userId,
      albumType: albumType || null,
      pageNo: pageNo ? parseInt(pageNo, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

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
 * 获取自定义相册中的图片列表（POST方式，统一接口风格）
 */
async function queryByCustomAlbum(req, res, next) {
  try {
    const userId = req.user.userId;
    const { pageNo, pageSize, albumKey } = req.body;

    const result = await albumService.getAlbumImagesList({
      userId,
      albumId: parseInt(albumKey),
      pageNo,
      pageSize,
    });

    res.sendResponse({ data: { list: result.list, total: result.total } });
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
  getAlbumsList,
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  queryByCustomAlbum,
  addImagesToAlbum,
  removeImagesFromAlbum,
  setAlbumCover,
  toggleFavoriteImage,
};
