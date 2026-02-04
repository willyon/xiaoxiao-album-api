/*
 * @Description: 收藏（喜欢）业务逻辑服务
 */
const albumModel = require("../models/albumModel");

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
  toggleFavoriteImage,
  addImagesToFavorites,
  removeImagesFromFavorites,
};
