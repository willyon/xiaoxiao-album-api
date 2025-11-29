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
const { handleGetAllByPage, handleCheckFileExists } = require("../controllers/imageController");
const { handleDownloadSingleImage, handleDownloadBatchImages } = require("../controllers/downloadController");
const { handlePostImages } = require("../controllers/uploadController");
const { handleGetUploadSignature } = require("../controllers/ossUploadController");
const {
  handleSearchImages,
  handleGetSearchSuggestions,
  handleIndexImage,
  handleGetQueueStatus,
  handleAdvancedSearch,
  handleGetFilterOptionsPaginated,
} = require("../controllers/searchController");
const cleanupRoutes = require("./cleanupRoutes");
const trashRoutes = require("./trashRoutes");
const albumRoutes = require("./albumRoutes");

//上传图片
router.post("/postImages", upload, handlePostImages);

// 预检和直传相关路由
router.post("/checkFileExists", handleCheckFileExists);
router.post("/getUploadSignature", handleGetUploadSignature);

// 图片下载相关路由
router.get("/download/:imageId", handleDownloadSingleImage);
router.post("/download/batch", handleDownloadBatchImages);

// 分页获取图片信息
router.post("/queryAllByPage", handleGetAllByPage);
// 注意：获取目录数据的接口已统一到 /images/albums/:type/catalogs (year/month/date/custom)
// 注意：获取具体相册图片的接口已统一到 /images/albums/:type/query (year/month/date/custom)

// ========== 搜索相关路由 ========== //
// 基础搜索
router.post("/search/images", handleSearchImages);

// 高级搜索
router.post("/search/advanced", handleAdvancedSearch);

// 搜索建议
router.get("/search/suggestions", handleGetSearchSuggestions);

// 分页获取筛选选项（用于滚动加载）
router.get("/search/filter-options-paginated", handleGetFilterOptionsPaginated);

// 手动索引单个图片
router.post("/search/index-image", handleIndexImage);

// 获取队列状态
router.get("/search/queue-status", handleGetQueueStatus);

// 智能清理相关路由
router.use("/cleanup", cleanupRoutes);

// 回收站相关路由
router.use("/trash", trashRoutes);

// 相册相关路由
router.use("/albums", albumRoutes);

module.exports = router;
