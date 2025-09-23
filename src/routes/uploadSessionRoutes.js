/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话路由
 */
const express = require("express");
const router = express.Router();
const { handleCreateSession, handleGetActiveSession, handleUpdateSessionData } = require("../controllers/uploadSessionController");
const { progressStream } = require("../controllers/imageProcessingProgressController");

// 创建上传会话
router.post("/sessions", handleCreateSession);

// 更新会话数据（统一接口）
router.put("/sessions/:id/update", handleUpdateSessionData);

// 获取用户的最新会话
router.get("/sessions/active", handleGetActiveSession);

// 进度推送流（SSE）
router.get("/progress/stream", progressStream);

module.exports = router;
