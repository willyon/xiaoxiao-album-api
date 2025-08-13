/*
 * @Author: zhangshouchang
 * @Date: 2024-12-17 02:03:49
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-10 16:53:59
 * @Description: 提供全局唯一的 Redis 客户端连接；已改为使用 ioredis
 */
const Redis = require("ioredis");

let redisClient = null;

const getRedisClient = () => {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB || 0,
    });

    redisClient.on("connect", () => {
      console.log("ioredis connected successfully!");
    });

    redisClient.on("error", (err) => {
      console.error("ioredis connection error:", err);
    });
  }

  return redisClient;
};

module.exports = { getRedisClient };
