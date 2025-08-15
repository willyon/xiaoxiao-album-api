/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 17:02:19
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-15 17:04:59
 * @Description: File description
 */
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({
  maxRetriesPerRequest: null,
});

const metaQueue = new Queue("image-meta", {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.UPLOAD_JOB_ATTEMPTS), //最多尝试次数（包括第一次执行）
    backoff: {
      type: "exponential", //每次重试的间隔时间按指数增长 第一次延迟delay毫秒 第二次延迟delay*2毫秒 第三次延迟delay*3毫秒 以此类推
      delay: Number(process.env.UPLOAD_JOB_BACKOFF_DELAY),
    },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

async function closeMetaQueue() {
  await metaQueue.close();
  await connection.quit();
}

module.exports = { metaQueue, closeMetaQueue };
