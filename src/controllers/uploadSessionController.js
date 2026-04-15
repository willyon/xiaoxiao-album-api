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
 * 处理获取上传会话列表请求
 * GET /upload-sessions?active=true
 */
const handleGetActiveSession = async (req, res, next) => {
  try {
    const userId = req.user.userId
    const { active } = req.query

    // 如果 active=true，只返回活跃会话；否则返回所有会话（未来扩展）
    if (active === 'true') {
      const activeSession = await getActiveSession(userId)
      res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: activeSession
      })
    } else {
      // TODO: 如果需要返回所有会话列表，需要实现新方法
      const activeSession = await getActiveSession(userId)
      res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: activeSession
      })
    }
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
