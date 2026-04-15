/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 图片处理进度管理服务
 */
const { getRedisClient } = require('./redisClient')
const logger = require('../utils/logger')
const { normalizeProgressData, computeCompleted } = require('../utils/uploadProgressSnapshot')

// 获取 Redis 客户端单实例
const redisClient = getRedisClient()

/**
 * 更新会话进度（统一接口）
 * @param {Object} params - 参数对象
 * @param {string} params.sessionId - 会话ID
 * @param {string} params.status - `upload:session:{sessionId}` 的 Hash 字段名；九字段含义见 ../utils/uploadProgressSnapshot.js
 * @param {number} params.increment - 增量值（默认为1）
 */
async function updateProgress({ sessionId, status, increment = 1 }) {
  if (!sessionId) return

  try {
    // 更新Redis计数：增加指定状态字段的计数值
    await redisClient.hincrby(`upload:session:${sessionId}`, status, increment)

    // 发布进度更新事件
    await _publishProgressUpdate(sessionId)
  } catch (error) {
    logger.error({
      message: '更新处理进度失败',
      details: { sessionId, status, increment, error: error.message }
    })
  }
}

/**
 * 同一会话同一 dedupeKey 对某 status 只递增一次（用于 ingestError / aiDone / aiError / aiEligible 等）。
 * status 字段语义见 ../utils/uploadProgressSnapshot.js
 */
async function updateProgressOnce({ sessionId, status, dedupeKey, increment = 1 }) {
  if (!sessionId || !status || !dedupeKey) return

  try {
    const markerKey = `upload:session:${sessionId}:counter_marker:${status}`
    const isFirstUpdate = await redisClient.sadd(markerKey, String(dedupeKey))
    await redisClient.expire(markerKey, 1 * 24 * 3600)

    if (isFirstUpdate === 1) {
      await updateProgress({ sessionId, status, increment })
    }
  } catch (error) {
    logger.error({
      message: '幂等进度更新失败',
      details: { sessionId, status, dedupeKey, increment, error: error.message }
    })
  }
}

/**
 * 发布图片处理进度更新事件
 * @param {string} sessionId - 会话ID
 */
async function _publishProgressUpdate(sessionId) {
  try {
    // 获取最新的会话数据
    const redisData = await redisClient.hgetall(`upload:session:${sessionId}`)

    if (redisData && Object.keys(redisData).length > 0) {
      const progressData = normalizeProgressData(sessionId, redisData)

      // 发布到Redis频道
      await redisClient.publish(`session:${sessionId}:progress`, JSON.stringify(progressData))
    }
  } catch (error) {
    logger.error({
      message: '发布进度更新失败',
      details: { sessionId, error: error.message }
    })
  }
}

/**
 * 设置Redis图片处理进度实时推送
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @param {string} sessionId - 会话ID
 */
async function setupProgressStream(req, res, sessionId) {
  let subscriber = null
  try {
    // 创建一个新的、独立的Redis连接（因为同一个redis连接不能同时用于命令执行和订阅）
    subscriber = redisClient.duplicate()

    // 添加连接错误处理
    subscriber.on('error', (err) => {
      logger.error({
        message: 'Redis订阅连接错误',
        details: { sessionId, error: err.message }
      })
    })

    subscriber.on('close', () => {
      logger.info({
        message: '图片处理进度推送Redis订阅连接已关闭',
        details: { sessionId }
      })
    })

    await subscriber.subscribe(`session:${sessionId}:progress`)

    // 立即推送当前 Redis 状态，解决「连接建立晚于 publish」导致的 pending 问题
    // 场景：Worker 处理快 / 重复文件时，publish 已发生，前端连接建立时已错过
    const redisData = await redisClient.hgetall(`upload:session:${sessionId}`)
    if (redisData && Object.keys(redisData).length > 0) {
      const progressData = normalizeProgressData(sessionId, redisData)
      res.write(`data: ${JSON.stringify(progressData)}\n\n`)

      // 立即检查是否已完成（如仅重复/已存在文件，或 Worker 已处理完）
      const isCompleted = progressData.completed === true

      if (isCompleted) {
        const completionMessage = { ...progressData, completed: true, timestamp: Date.now() }
        res.write(`data: ${JSON.stringify(completionMessage)}\n\n`)
        setTimeout(() => {
          try {
            if (subscriber.status === 'ready' || subscriber.status === 'connecting') {
              subscriber.unsubscribe()
              subscriber.disconnect()
            }
            res.end()
          } catch {
            if (!res.headersSent) res.end()
          }
        }, 500)
        return
      }
    }

    // 延迟完成判断的定时器
    let completionCheckTimer = null

    // 监听Redis消息
    subscriber.on('message', (channel, message) => {
      try {
        // 直接转发Redis消息给前端
        res.write(`data: ${message}\n\n`)

        // 清除之前的定时器
        if (completionCheckTimer) {
          clearTimeout(completionCheckTimer)
        }

        // 延迟检查完成状态，避免过早断开连接
        completionCheckTimer = setTimeout(() => {
          try {
            // 直接使用当前消息的数据，因为只有最后一条消息的定时器会执行
            const progressData = JSON.parse(message)

            const normalizedData = normalizeProgressData(sessionId, progressData)
            const isCompleted = computeCompleted(normalizedData)

            if (isCompleted) {
              // 发送完成确认消息，给前端时间处理
              const completionMessage = {
                ...normalizedData,
                completed: true,
                timestamp: Date.now()
              }
              res.write(`data: ${JSON.stringify(completionMessage)}\n\n`)

              // 延迟断开连接，确保前端有时间接收和处理完成消息
              setTimeout(() => {
                try {
                  // 检查连接状态，避免在已断开的连接上执行操作
                  if (subscriber.status === 'ready' || subscriber.status === 'connecting') {
                    subscriber.unsubscribe()
                    subscriber.disconnect()
                  }
                  res.end()
                } catch (error) {
                  logger.error({
                    message: '断开Redis订阅连接失败',
                    details: { sessionId, error: error.message }
                  })
                  // 确保响应结束
                  if (!res.headersSent) {
                    res.end()
                  }
                }
              }, 1000) // 1秒延迟
            }
          } catch (error) {
            logger.error({
              message: '延迟完成检查失败',
              details: { sessionId, error: error.message }
            })
          }
        }, 2000) // 2秒延迟，等待所有消息处理完毕
      } catch (error) {
        logger.error({
          message: '处理Redis消息失败',
          details: { sessionId, channel, error: error.message }
        })
      }
    })

    // 监听连接关闭，清理Redis订阅
    req.on('close', () => {
      try {
        // 清理定时器
        if (completionCheckTimer) {
          clearTimeout(completionCheckTimer)
        }

        // 检查连接状态，避免在已断开的连接上执行操作
        if (subscriber.status === 'ready' || subscriber.status === 'connecting') {
          subscriber.unsubscribe()
          subscriber.disconnect()
        }
      } catch (error) {
        logger.error({
          message: '清理Redis订阅连接失败',
          details: { sessionId, error: error.message }
        })
      }
    })
  } catch (error) {
    logger.error({
      message: '设置Redis进度推送失败',
      details: { sessionId, error: error.message }
    })

    // 确保在错误情况下也清理资源
    if (subscriber) {
      try {
        if (subscriber.status === 'ready' || subscriber.status === 'connecting') {
          subscriber.unsubscribe()
          subscriber.disconnect()
        }
      } catch (cleanupError) {
        logger.error({
          message: '清理Redis订阅连接失败（错误处理中）',
          details: { sessionId, error: cleanupError.message }
        })
      }
    }

    // 确保响应结束，但不发送错误消息给前端
    if (!res.headersSent) {
      res.end()
    }
  }
}

module.exports = {
  updateProgress,
  updateProgressOnce,
  publishProgressSnapshot: _publishProgressUpdate,
  setupProgressStream
}
