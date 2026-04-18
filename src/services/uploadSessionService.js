/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理服务
 */
const { v4: uuidv4 } = require('uuid')
const { getRedisClient } = require('./redisClient')
const logger = require('../utils/logger')
const { normalizeProgressData, hasAnyProgressData } = require('../utils/uploadProgressSnapshot')

// 获取 Redis 客户端实例
const redisClient = getRedisClient()

/**
 * 创建上传会话
 * @param {string|number} userId - 用户 ID。
 * @returns {Promise<object>} 会话快照对象。
 */
async function createSession(userId) {
  // 生成会话ID
  const sessionId = uuidv4()

  // 在 Redis 中创建会话 Hash（九字段语义见 ../utils/uploadProgressSnapshot.js 文件头）
  await redisClient.hset(`upload:session:${sessionId}`, {
    uploadedCount: 0,
    ingestDoneCount: 0,
    ingestErrorCount: 0,
    duplicateCount: 0,
    workerSkippedCount: 0,
    existingFiles: 0,
    aiEligibleCount: 0,
    aiDoneCount: 0,
    aiErrorCount: 0
  })

  // 设置用户的最新会话ID（覆盖之前的会话）
  await redisClient.set(`user:latest:session:${userId}`, sessionId)

  // 设置过期时间（1天）
  await redisClient.expire(`upload:session:${sessionId}`, 1 * 24 * 3600)
  await redisClient.expire(`user:latest:session:${userId}`, 1 * 24 * 3600)

  return {
    sessionId,
    uploadedCount: 0,
    ingestDoneCount: 0,
    ingestErrorCount: 0,
    duplicateCount: 0,
    workerSkippedCount: 0,
    existingFiles: 0,
    aiEligibleCount: 0,
    aiDoneCount: 0,
    aiErrorCount: 0,
    phase: 'uploading',
    completed: false,
    timestamp: Date.now()
  }
}

/**
 * 获取用户的活跃会话
 * @param {string|number} userId - 用户 ID。
 * @returns {Promise<object|null>} 活跃会话快照或 null。
 */
async function getActiveSession(userId) {
  // 获取用户的最新会话ID
  const activeSessionId = await redisClient.get(`user:latest:session:${userId}`)

  if (!activeSessionId) {
    return null
  }

  try {
    // 直接获取最新会话的详细信息
    const redisData = await redisClient.hgetall(`upload:session:${activeSessionId}`)

    if (redisData && Object.keys(redisData).length > 0) {
      const snapshot = normalizeProgressData(activeSessionId, redisData)
      const isActive = hasAnyProgressData(snapshot) && !snapshot.completed

      if (!isActive) {
        return null
      }

      return snapshot
    }

    return null
  } catch (redisError) {
    logger.warn({
      message: 'Redis数据获取失败',
      details: { sessionId: activeSessionId, error: redisError.message }
    })
    return null
  }
}

/**
 * 获取当前上传进度快照。
 * @param {string|number} userId - 用户 ID。
 * @returns {Promise<{active:boolean,session:object|null}>} 当前会话进度状态。
 */
async function getCurrentProgressSnapshot(userId) {
  const activeSessionId = await redisClient.get(`user:latest:session:${userId}`)
  if (!activeSessionId) {
    return { active: false, session: null }
  }

  const redisData = await redisClient.hgetall(`upload:session:${activeSessionId}`)
  if (!redisData || Object.keys(redisData).length === 0) {
    return { active: false, session: null }
  }

  const snapshot = normalizeProgressData(activeSessionId, redisData)
  const active = hasAnyProgressData(snapshot) && !snapshot.completed

  if (!active) {
    return { active: false, session: null }
  }

  return { active: true, session: snapshot }
}

/**
 * 将媒体 ID 绑定到上传会话。
 * @param {{sessionId:string,mediaId:number|string}} params - 绑定参数。
 * @returns {Promise<void>} 无返回值。
 */
async function addMediaToSession({ sessionId, mediaId }) {
  if (!sessionId || !mediaId) return
  const sessionMediaSetKey = `upload:session:${sessionId}:media_ids`
  await redisClient.sadd(sessionMediaSetKey, String(mediaId))
  await redisClient.expire(sessionMediaSetKey, 1 * 24 * 3600)
}

module.exports = {
  createSession,
  getActiveSession,
  getCurrentProgressSnapshot,
  addMediaToSession
}
