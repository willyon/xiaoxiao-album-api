/*
 * 标签相关路由
 */

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const { handleGetPopularTags } = require("../controllers/tagController");

// 所有标签相关接口需要鉴权
router.use(authMiddleware);

// 获取热门标签
router.get("/popular", handleGetPopularTags);

module.exports = router;

