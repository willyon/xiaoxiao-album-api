/*
 * @Description: 收藏（喜欢）业务逻辑服务
 */
const albumModel = require('../models/albumModel')

/**
 * 切换单张图片的收藏状态
 */
async function toggleFavoriteMedia({ userId, imageId, isFavorite }) {
  return albumModel.toggleFavoriteMedia({
    userId,
    imageId,
    isFavorite
  })
}

/**
 * 批量添加图片到收藏
 */
async function addMediasToFavorites({ userId, imageIds }) {
  return albumModel.addMediasToFavorite({ userId, imageIds })
}

/**
 * 批量从收藏中移除图片
 */
async function removeMediasFromFavorites({ userId, imageIds }) {
  return albumModel.removeMediasFromFavorite({ userId, imageIds })
}

module.exports = {
  toggleFavoriteMedia,
  addMediasToFavorites,
  removeMediasFromFavorites
}
