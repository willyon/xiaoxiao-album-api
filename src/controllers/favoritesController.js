/*
 * @Description: 收藏（喜欢）接口控制器
 */
const favoriteService = require("../services/favoriteService");

/**
 * 分页获取喜欢图片列表
 * GET /api/favorites?pageNo=1&pageSize=20
 * 返回 { list, total }
 */
async function getFavorites(req, res, next) {
  try {
    const userId = req.user.userId;
    const { pageNo = 1, pageSize = 20 } = req.query;

    const result = await favoriteService.getFavoritesList({
      userId,
      pageNo: parseInt(pageNo, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
    });

    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 批量添加图片到收藏
 * POST /api/favorites/images  body: { imageIds: number[] }
 */
async function addToFavorites(req, res, next) {
  try {
    const userId = req.user.userId;
    const { imageIds } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return next({
        httpStatus: 400,
        messageCode: "INVALID_PARAMETERS",
        messageType: "warning",
        message: "图片ID列表不能为空",
      });
    }

    const result = await favoriteService.addImagesToFavorites({
      userId,
      imageIds: imageIds.map((id) => parseInt(id)),
    });
    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * 批量从收藏中移除图片
 * DELETE /api/favorites/images  body: { imageIds: number[] }
 */
async function removeFromFavorites(req, res, next) {
  try {
    const userId = req.user.userId;
    const { imageIds } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return next({
        httpStatus: 400,
        messageCode: "INVALID_PARAMETERS",
        messageType: "warning",
        message: "图片ID列表不能为空",
      });
    }

    const result = await favoriteService.removeImagesFromFavorites({
      userId,
      imageIds: imageIds.map((id) => parseInt(id)),
    });
    res.sendResponse({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getFavorites,
  addToFavorites,
  removeFromFavorites,
};
