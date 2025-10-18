/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-28
 * @Description: 搜索索引队列定义
 */
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({ maxRetriesPerRequest: null }); // 默认连接到本地 Redis

// 创建搜索索引处理队列
const searchIndexQueue = new Queue(process.env.SEARCH_INDEX_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.IMAGE_SEARCH_INDEX_JOB_ATTEMPTS || 5),
    backoff: {
      type: "exponential",
      delay: Number(process.env.IMAGE_SEARCH_INDEX_JOB_BACKOFF_DELAY || 1000),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeSearchIndexQueue() {
  await searchIndexQueue.close();
  await connection.quit();
}

module.exports = { searchIndexQueue, queueConnection: connection, closeSearchIndexQueue };
