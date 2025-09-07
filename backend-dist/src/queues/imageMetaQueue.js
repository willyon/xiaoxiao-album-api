/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 17:02:19
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:08:51
 * @Description: File description
 */
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({
  maxRetriesPerRequest: null,
});

const imageMetaQueue = new Queue(process.env.IMAGE_META_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.IMAGE_META_JOB_ATTEMPTS || 5), //最多尝试次数（包括第一次执行）
    backoff: {
      type: "exponential", //每次重试的间隔时间按指数增长 第一次延迟delay毫秒 第二次延迟delay*2毫秒 第三次延迟delay*3毫秒 以此类推
      delay: Number(process.env.IMAGE_META_JOB_BACKOFF_DELAY || 1000),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeImageMetaQueue() {
  await imageMetaQueue.close();
  await connection.quit();
}

module.exports = { imageMetaQueue, closeImageMetaQueue };
