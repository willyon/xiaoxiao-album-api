/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理控制器
 */
const { createSession, getActiveSession, getCurrentProgressSnapshot } = require('../services/uploadSessionService')
const { SUCCESS_CODES } = require('../constants/messageCodes')

/**
 * 处理创建上传会话请求
 */
const handleCreateSession = async (req, res, next) => {
  try {
    const userId = req.user.userId

    const session = await createSession(userId)

    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: session
    })
  } catch (error) {
    next(error)
  }
}

/**
 * 获取当前「进行中」的上传会话（与历史 `?active=true` 行为一致）。
 * 全量会话列表需额外 Redis 结构，未实现前不再保留无意义的 if/else 分支。
 * GET /upload-sessions
 */
const handleGetActiveSession = async (req, res, next) => {
  try {
    const userId = req.user.userId
    const activeSession = await getActiveSession(userId)
    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: activeSession
    })
  } catch (error) {
    next(error)
  }
}

/**
 * 获取当前会话快照
 * GET /upload-sessions/current-progress
 */
const handleGetCurrentProgress = async (req, res, next) => {
  try {
    const userId = req.user.userId
    const snapshot = await getCurrentProgressSnapshot(userId)
    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: snapshot
    })
  } catch (error) {
    next(error)
  }
}

module.exports = {
  handleCreateSession,
  handleGetActiveSession,
  handleGetCurrentProgress
}
