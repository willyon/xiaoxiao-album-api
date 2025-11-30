/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能路由
 */

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const {
  handleSearchImages,
  handleGetSearchSuggestions,
  handleIndexImage,
  handleGetQueueStatus,
  handleAdvancedSearch,
  handleGetFilterOptionsPaginated,
} = require("../controllers/searchController");

// 应用认证中间件
router.use(authMiddleware);

// 搜索图片（基础搜索和高级搜索统一，通过 advanced query param 区分）
router.post("/images", handleSearchImages);

// 搜索建议
router.get("/suggestions", handleGetSearchSuggestions);

// 获取筛选选项（用于滚动加载）
router.get("/filters", handleGetFilterOptionsPaginated);

// 手动索引单个图片
router.post("/index-image", handleIndexImage);

// 获取队列状态
router.get("/queue-status", handleGetQueueStatus);

module.exports = router;
