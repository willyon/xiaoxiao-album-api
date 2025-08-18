/*
 * @Author: zhangshouchang
 * @Date: 2025-08-12 14:54:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 11:30:54
 * @Description: File description
 */
const { getRedisClient } = require("../services/redisClient");
const { getUserImageHashes } = require("../services/imageService");
const logger = require("../utils/logger");

const readyKeyOf = (uid) => `images:hashset:ready:${uid}`;
const lockKeyOf = (uid) => `lock:images:hashset:init:${uid}`;
const userSetKey = (uid) => `images:hashset:user:${uid}`;
const timeIt = require("../utils/timeIt");

// 进程内缓存：该 userId 是否已“就绪” 不用每次开始时都是直接到redis去查找 节省资源
const userReadyCache = new Map(); // userId -> true

async function ensureUserSetReady(userId) {
  if (userReadyCache.get(userId)) return; // 本进程已标记就绪

  const redis = getRedisClient();
  const ready = timeIt(" ensureUserSetReady", async () => redis.get(readyKeyOf(userId)));
  // const ready = await redis.get(readyKeyOf(userId)); //redis.get的返回结果：字符串或者null
  if (ready) {
    // 其他进程已完成初始化
    userReadyCache.set(userId, true);
    return;
  }

  // 分布式锁，避免并发初始化 gotLock结果为nulh或非null
  // NX(Only Set If Not Exists)：只有当 key 不存在时才会设置（防止多个进程同时初始化）。
  // EX 30：锁 30 秒后自动过期（避免死锁）。
  // 1:要写入的redis值 在分布式锁场景中，这个值通常没什么特别含义（可以是 "1"、时间戳、UUID 等），
  // 关键是 是否有这个 key 存在 决定了锁是否被占用。
  const gotLock = await redis.set(lockKeyOf(userId), "1", "NX", "EX", 30);
  if (!gotLock) {
    for (let i = 0; i < 10; i++) {
      // 最多等 4s
      await new Promise((r) => setTimeout(r, 400));
      const ok = await redis.get(readyKeyOf(userId));
      if (ok) {
        userReadyCache.set(userId, true);
        return;
      }
    }
    // 超时兜底
    logger.error({
      message: `等待初始化用户 ${userId} 的 hashSet 超时`,
    });
  }

  try {
    // 真正初始化：从 DB 拉该用户全部 hash 批量写入
    const hashes = timeIt("getUserImageHashes", async () => getUserImageHashes(userId));
    // const hashes = await getUserImageHashes(userId); // string[]
    // 开启 Redis 管道（pipeline）模式，允许一次性把多个命令打包发送给 Redis，减少网络往返次数，提高性能
    timeIt("hashset pineline", async () => {
      const pipeline = redis.pipeline();
      if (hashes?.length) {
        hashes.forEach((h) => pipeline.sadd(userSetKey(userId), h));
      }
      //需要set这么一个key来标记当前useriId已经设置过hash集合了，因为仅仅是sadd的话，如果hash结果是空的情况下，
      // 后续无法知道是因为集合为空，还是因为key不存在。
      //  加 TTL（比如 1 小时），减少后续 GET 的命中成本
      pipeline.set(readyKeyOf(userId), "1", "EX", 3600);
      await pipeline.exec();
    });
    // const pipeline = redis.pipeline();
    // if (hashes?.length) {
    //   hashes.forEach((h) => pipeline.sadd(userSetKey(userId), h));
    // }
    // //需要set这么一个key来标记当前useriId已经设置过hash集合了，因为仅仅是sadd的话，如果hash结果是空的情况下，
    // // 后续无法知道是因为集合为空，还是因为key不存在。
    // //  加 TTL（比如 1 小时），减少后续 GET 的命中成本
    // pipeline.set(readyKeyOf(userId), "1", "EX", 3600);
    // await pipeline.exec();
    userReadyCache.set(userId, true);
  } finally {
    await redis.del(lockKeyOf(userId));
  }
}

module.exports = { ensureUserSetReady, userSetKey, readyKeyOf, lockKeyOf };
