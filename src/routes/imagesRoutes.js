/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 14:06:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-14 00:54:38
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload"); // 引入 upload 中间件
const {
  handleGetBlurryImages,
  handleGetSimilarGroups,
  handleCheckFileExists,
  handlePatchImage,
  handleDeleteImages,
} = require("../controllers/imageController");
const { handleDownloadSingleImage, handleDownloadBatchImages } = require("../controllers/downloadController");
const { handlePostImages } = require("../controllers/uploadController");
const { handleGetUploadSignature } = require("../controllers/ossUploadController");

// ========== 图片 CRUD 接口 ========== //
// 批量上传图片
router.post("/", upload, handlePostImages);

// 分页获取模糊图列表（清理页模糊图 tab）
router.get("/blurry", handleGetBlurryImages);

// 分页获取相似图分组列表（清理页相似图 tab）
router.get("/similar", handleGetSimilarGroups);

// 部分更新图片信息（仅用于 favorite 字段）
router.patch("/:imageId", handlePatchImage);

// 批量删除图片（软删除，移至回收站）
router.delete("/", handleDeleteImages);

// ========== 图片上传相关接口 ========== //
// 检查文件是否已存在
router.post("/check-exists", handleCheckFileExists);

// 获取上传签名（OSS直传）
router.post("/upload/signature", handleGetUploadSignature);

// ========== 图片下载相关接口 ========== //
// 单张图片下载
router.get("/:imageId/download", handleDownloadSingleImage);

// 批量图片下载（ZIP）
router.post("/download", handleDownloadBatchImages);

module.exports = router;
