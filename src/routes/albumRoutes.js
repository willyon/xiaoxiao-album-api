/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册路由
 */
const express = require("express");
const router = express.Router();
const {
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
} = require("../controllers/albumController");

// 切换图片喜欢状态（必须在 /:albumId 之前，避免被匹配为 albumId）
router.post("/favorite/toggle", toggleFavoriteImage);

// 获取相册列表
router.get("/", getAlbumsList);

// 创建相册
router.post("/", createAlbum);

// 获取相册详情
router.get("/:albumId", getAlbumById);

// 更新相册
router.put("/:albumId", updateAlbum);

// 删除相册
router.delete("/:albumId", deleteAlbum);

// 添加图片到相册
router.post("/:albumId/images", addImagesToAlbum);

// 从相册中移除图片
router.delete("/:albumId/images", removeImagesFromAlbum);

// 设置相册封面图片
router.post("/:albumId/set-cover", setAlbumCover);

module.exports = router;
