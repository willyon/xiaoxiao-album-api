/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册路由
 */
const express = require("express");
const router = express.Router();
const {
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  queryAlbumPhotos,
  getCustomAlbums,
  getRecentAlbums,
  addImagesToAlbum,
  removeImagesFromAlbum,
  setAlbumCover,
  getAutoAlbums,
} = require("../controllers/albumController");

// ========== 相册列表接口 ========== //
// 获取自定义相册列表
router.get("/", getCustomAlbums);

// 获取最近使用的相册（须在 /:albumId 之前注册）
router.get("/recent", getRecentAlbums);

// 获取自动相册列表（宠物、海边、家庭日常等）
router.get("/auto", getAutoAlbums);

// ========== 相册 CRUD 接口 ========== //
// 创建相册
router.post("/", createAlbum);

// 获取相册详情
router.get("/:albumId", getAlbumById);

// 完整更新相册
router.put("/:albumId", updateAlbum);

// 删除相册
router.delete("/:albumId", deleteAlbum);

// ========== 相册媒体管理接口 ========== //
// 获取相册媒体列表（移除 type 参数，直接从 albumId 判断类型）
router.get("/:albumId/media", queryAlbumPhotos);

// 添加媒体到相册
router.post("/:albumId/media", addImagesToAlbum);

// 从相册中移除媒体
router.delete("/:albumId/media", removeImagesFromAlbum);

// 设置相册封面图片
router.put("/:albumId/cover", setAlbumCover);

module.exports = router;
