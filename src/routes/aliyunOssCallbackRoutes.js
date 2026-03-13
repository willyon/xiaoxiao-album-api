/*
 * @Author: zhangshouchang
 * @Date: 2025-01-08
 * @Description: 阿里云OSS回调路由 - 不需要鉴权
 */
const express = require("express");
const router = express.Router();
const { handleUploadCallback } = require("../controllers/ossUploadController");

// 阿里云OSS媒体上传完成回调 - 不需要鉴权
router.post("/mediaUploadCallback", handleUploadCallback);

module.exports = router;
