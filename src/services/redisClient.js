// services/redisClient.js
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
