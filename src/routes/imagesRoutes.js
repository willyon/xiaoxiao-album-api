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
  handleGetAllByPage,
  handleGetByCertainYear,
  handleGetByCertainMonth,
  handleGetByCertainDate,
  handleGroupByYear,
  handleGroupByMonth,
  handleGroupByDate,
  handleCheckFileExists,
} = require("../controllers/imageController");
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

//上传图片
router.post("/postImages", upload, handlePostImages);

// 预检和直传相关路由
router.post("/checkFileExists", handleCheckFileExists);
router.post("/getUploadSignature", handleGetUploadSignature);

// 分页获取图片信息
router.post("/queryAllByPage", handleGetAllByPage);
// 分页获取按年份分组数据
router.post("/queryGroupByYear", handleGroupByYear);
// 分页获取按月份分组数据
router.post("/queryGroupByMonth", handleGroupByMonth);
// 分页获取按日期分组数据
router.post("/queryGroupByDate", handleGroupByDate);
// 分页获取具体某个年份的图片信息
router.post("/queryByCertainYear", handleGetByCertainYear);
// 分页获取具体某个月份的图片信息
router.post("/queryByCertainMonth", handleGetByCertainMonth);
// 分页获取具体某个日期的图片信息
router.post("/queryByCertainDate", handleGetByCertainDate);

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

module.exports = router;
