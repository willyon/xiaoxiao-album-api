/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话路由
 */
const express = require('express')
const router = express.Router()
const { handleCreateSession, handleGetActiveSession, handleGetCurrentProgress } = require('../controllers/uploadSessionController')

// 创建上传会话
router.post('/', handleCreateSession)

// 获取当前进行中的上传会话（全量列表未实现）
router.get('/', handleGetActiveSession)

// 当前会话快照（处理中心首屏恢复）
router.get('/current-progress', handleGetCurrentProgress)

module.exports = router
