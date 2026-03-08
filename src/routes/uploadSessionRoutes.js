/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话路由
 */
const express = require("express");
const router = express.Router();
const {
  handleCreateSession,
  handleGetActiveSession,
  handleGetCurrentProgress,
  handleGetSessionFailures,
  handleRetrySessionFailures,
} = require("../controllers/uploadSessionController");

// 创建上传会话
router.post("/", handleCreateSession);

// 获取上传会话列表（支持 active 查询参数）
router.get("/", handleGetActiveSession);

// 当前会话快照（处理中心首屏恢复）
router.get("/current-progress", handleGetCurrentProgress);

// 会话失败明细
router.get("/:sessionId/failures", handleGetSessionFailures);

// 会话失败重试
router.post("/:sessionId/retry-failures", handleRetrySessionFailures);

module.exports = router;
