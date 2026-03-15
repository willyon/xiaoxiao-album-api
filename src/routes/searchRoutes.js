/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能路由
 */

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const {
  handleSearchMedias,
  handleGetSearchSuggestions,
  handleGetQueueStatus,
  handleGetFilterOptionsPaginated,
  handleGetSceneFilterOptionsPaginated,
  handleGetObjectFilterOptionsPaginated,
} = require("../controllers/searchController");

// 应用认证中间件
router.use(authMiddleware);

// 搜索/列表媒体（统一接口：可选 scope + 可选 query + filters）
router.post("/media", handleSearchMedias);

// 搜索建议
router.get("/suggestions", handleGetSearchSuggestions);

// 获取筛选选项（用于滚动加载）
router.get("/filters", handleGetFilterOptionsPaginated);
router.get("/filters/scenes", handleGetSceneFilterOptionsPaginated);
router.get("/filters/objects", handleGetObjectFilterOptionsPaginated);

// 获取队列状态
router.get("/queue-status", handleGetQueueStatus);

module.exports = router;
