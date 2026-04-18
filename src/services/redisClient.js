/*
 * @Author: zhangshouchang
 * @Date: 2024-12-17 02:03:49
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:50:52
 * @Description: 提供全局唯一的 Redis 客户端连接；已改为使用 ioredis
 */
const Redis = require('ioredis')
const logger = require('../utils/logger')

let redisClient = null

/**
 * 获取全局单例 Redis 客户端。
 * @returns {import('ioredis').Redis} Redis 客户端实例。
 */
const getRedisClient = () => {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB || 0
    })

    redisClient.on('connect', () => {
      // 仅在非脚本模式下显示连接成功日志
      const isScriptMode = process.env.NODE_ENV === 'script' || process.argv[1]?.includes('scripts/')
      if (!isScriptMode) {
        logger.info({ message: '通用ioredis已连接成功!' })
      }
    })

    redisClient.on('error', (err) => {
      logger.error({
        message: 'ioredis connection error',
        stack: err?.stack,
        details: { error: err?.message }
      })
    })
  }

  return redisClient
}

module.exports = { getRedisClient }
