/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话路由
 */
const express = require("express");
const router = express.Router();
const { handleCreateSession, handleGetActiveSession } = require("../controllers/uploadSessionController");

// 创建上传会话
router.post("/sessions", handleCreateSession);

// 获取用户的最新会话
router.get("/sessions/active", handleGetActiveSession);

module.exports = router;
