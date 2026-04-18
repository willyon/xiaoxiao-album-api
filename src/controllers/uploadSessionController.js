/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理控制器
 */
const { createSession, getActiveSession, getCurrentProgressSnapshot } = require('../services/uploadSessionService')
const { SUCCESS_CODES } = require('../constants/messageCodes')
const asyncHandler = require('../utils/asyncHandler')

/**
 * 处理创建上传会话请求
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleCreateSession(req, res) {
  const userId = req.user.userId

  const session = await createSession(userId)

  res.sendResponse({
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    data: session
  })
}

/**
 * 获取当前「进行中」的上传会话（与历史 `?active=true` 行为一致）。
 * 全量会话列表需额外 Redis 结构，未实现前不再保留无意义的 if/else 分支。
 * GET /upload-sessions
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetActiveSession(req, res) {
  const userId = req.user.userId
  const activeSession = await getActiveSession(userId)
  res.sendResponse({
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    data: activeSession
  })
}

/**
 * 获取当前会话快照
 * GET /upload-sessions/current-progress
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleGetCurrentProgress(req, res) {
  const userId = req.user.userId
  const snapshot = await getCurrentProgressSnapshot(userId)
  res.sendResponse({
    messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    data: snapshot
  })
}

module.exports = {
  handleCreateSession: asyncHandler(handleCreateSession),
  handleGetActiveSession: asyncHandler(handleGetActiveSession),
  handleGetCurrentProgress: asyncHandler(handleGetCurrentProgress)
}
