/*
 * @Author: zhangshouchang
 * @Date: 2025-08-12 14:54:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 11:30:54
 * @Description: File description
 */
const { getRedisClient } = require('../services/redisClient')
const { getUserMediaHashes } = require('../services/mediaService')
const logger = require('../utils/logger')

const readyKeyOf = (uid) => `images:hashset:ready:${uid}`
const lockKeyOf = (uid) => `lock:images:hashset:init:${uid}`
const userSetKey = (uid) => `images:hashset:user:${uid}`

async function ensureUserSetReady(userId) {
  const redis = getRedisClient()

  // 直接检查 Redis 的 ready 标记（GET 操作很快，是设计的核心）
  const ready = await redis.get(readyKeyOf(userId))
  if (ready) {
    // ready 标记存在，说明已初始化完成
    return
  }

  // ready 标记不存在，说明：
  // 1. 从未初始化过，或
  // 2. Redis 被清空了，或
  // 3. ready 标记过期了（TTL 1小时）
  // 需要重新初始化

  // 分布式锁，避免并发初始化 gotLock结果为nulh或非null
  // NX(Only Set If Not Exists)：只有当 key 不存在时才会设置（防止多个进程同时初始化）。
  // EX 30：锁 30 秒后自动过期（避免死锁）。
  // 1:要写入的redis值 在分布式锁场景中，这个值通常没什么特别含义（可以是 "1"、时间戳、UUID 等），
  // 关键是 是否有这个 key 存在 决定了锁是否被占用。
  const gotLock = await redis.set(lockKeyOf(userId), '1', 'NX', 'EX', 30)
  if (!gotLock) {
    // 没有获得锁，等待其他进程初始化完成
    for (let i = 0; i < 10; i++) {
      // 最多等 4s
      await new Promise((r) => setTimeout(r, 400))
      const ok = await redis.get(readyKeyOf(userId))
      if (ok) {
        return
      }
    }
    // 等待超时后，再次检查 Set 是否已初始化（可能 ready 标记过期了但 Set 还在）
    const setExists = await redis.exists(userSetKey(userId))
    if (setExists) {
      logger.warn({
        message: '等待超时但 Set 已存在，标记为就绪',
        details: { userId }
      })
      // 重新设置 ready 标记，避免每次都检查 Set
      await redis.set(readyKeyOf(userId), '1', 'EX', 3600)
      return
    }
    // Set 也不存在，记录错误并返回
    logger.error({
      message: `等待初始化用户 ${userId} 的 hashSet 超时`
    })
    return // 没有获得锁且等待超时，直接返回
  }

  // 获得了锁，执行初始化
  try {
    // 真正初始化：从 DB 拉该用户全部 hash 批量写入
    const hashes = await getUserMediaHashes(userId)

    // 开启 Redis 管道（pipeline）模式，允许一次性把多个命令打包发送给 Redis，减少网络往返次数，提高性能
    const pipeline = redis.pipeline()
    if (hashes?.length) {
      hashes.forEach((h) => pipeline.sadd(userSetKey(userId), h))
    }
    //需要set这么一个key来标记当前useriId已经设置过hash集合了，因为仅仅是sadd的话，如果hash结果是空的情况下，
    // 后续无法知道是因为集合为空，还是因为key不存在。
    //  加 TTL（比如 1 小时），减少后续 GET 的命中成本
    pipeline.set(readyKeyOf(userId), '1', 'EX', 3600)
    await pipeline.exec()

    logger.info({
      message: '用户图片 Hash Set 初始化完成',
      details: { userId, hashCount: hashes?.length || 0 }
    })
  } finally {
    // 只有获得锁的进程才释放锁
    if (gotLock) {
      await redis.del(lockKeyOf(userId))
    }
  }
}

/**
 * 从用户维度的上传去重集合中移除哈希（彻底删除媒体后调用，避免 Redis 残留导致无法重新导入同文件）
 * @param {number} userId
 * @param {Array<string|undefined|null>} hashes
 */
async function removeHashesFromUserSet(userId, hashes) {
  const unique = [...new Set((hashes || []).filter((h) => h != null && String(h).length > 0))]
  if (unique.length === 0) return
  const redis = getRedisClient()
  await redis.srem(userSetKey(userId), ...unique)
}

module.exports = { ensureUserSetReady, userSetKey, readyKeyOf, lockKeyOf, removeHashesFromUserSet }
