/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 进度推送路由 - 不需要认证（EventSource限制）
 */
const express = require('express')
const router = express.Router()
const { progressStream } = require('../controllers/mediaProcessingProgressController')

// 进度推送流（SSE）- 不需要认证
router.get('/stream', progressStream)

module.exports = router
