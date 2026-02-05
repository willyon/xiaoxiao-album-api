/*
 * @Description: 收藏（喜欢）接口控制器
 */
const favoriteService = require("../services/favoriteService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");

/**
 * 批量添加图片到收藏
 * POST /api/favorites/images  body: { imageIds: number[] }
 */
async function addToFavorites(req, res, next) {
  try {
    const userId = req.user.userId;
    const { imageIds } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
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
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
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
  addToFavorites,
  removeFromFavorites,
};
