/*
 * @Description: 收藏（喜欢）业务逻辑服务
 */
const albumModel = require("../models/albumModel");
const imageModel = require("../models/imageModel");
const storageService = require("../services/storageService");

/**
 * 分页获取收藏图片列表
 * 返回 { list, total }，list 中每项含 thumbnailUrl、highResUrl
 */
async function getFavoritesList({ userId, pageNo = 1, pageSize = 20 }) {
  const queryResult = imageModel.getImagesByFavorite({ userId, pageNo, pageSize });
  const total = queryResult.total;
  const list = await Promise.all(
    queryResult.data.map(async (image) => {
      const thumbnailUrl = await storageService.getFileUrl(image.thumbnailStorageKey, image.storageType);
      const highResUrl = await storageService.getFileUrl(image.highResStorageKey, image.storageType);
      return {
        ...image,
        thumbnailUrl,
        highResUrl,
      };
    }),
  );
  return { list, total };
}

/**
 * 切换单张图片的收藏状态
 */
async function toggleFavoriteImage({ userId, imageId, isFavorite }) {
  return albumModel.toggleFavoriteImage({
    userId,
    imageId,
    isFavorite,
  });
}

/**
 * 批量添加图片到收藏
 */
async function addImagesToFavorites({ userId, imageIds }) {
  return albumModel.addImagesToFavorite({ userId, imageIds });
}

/**
 * 批量从收藏中移除图片
 */
async function removeImagesFromFavorites({ userId, imageIds }) {
  return albumModel.removeImagesFromFavorite({ userId, imageIds });
}

module.exports = {
  getFavoritesList,
  toggleFavoriteImage,
  addImagesToFavorites,
  removeImagesFromFavorites,
};
