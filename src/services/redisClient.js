/*
 * @Author: zhangshouchang
 * @Date: 2024-12-17 02:03:49
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-27 21:18:47
 * @Description: 提供全局唯一的 Redis 客户端连接；
 */
const { createClient } = require("redis");

let redisClient = null;

const getRedisClient = async () => {
  if (!redisClient) {
    redisClient = createClient();
    try {
      await redisClient.connect();
      console.log("Redis connected successfully!");
    } catch (error) {
      console.error("Error connecting to Redis:", error);
      redisClient = null; // 确保失败时不返回未连接的客户端
    }
  }
  return redisClient;
};

module.exports = { getRedisClient };
