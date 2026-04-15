/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 16:38:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:10:58
 * @Description: 创建上传队列
 */
const { Queue } = require("bullmq");
const Redis = require("ioredis");
const { QUEUE_JOB_ATTEMPTS } = require("../config/queueConfig");

const connection = new Redis({ maxRetriesPerRequest: null }); // 默认连接到本地 Redis

// 设置默认的 attempts/backoff/清理策略，避免每次 add 都重复传
const mediaUploadQueue = new Queue(process.env.MEDIA_UPLOAD_QUEUE_NAME || "media-upload", {
  connection,
  defaultJobOptions: {
    attempts: QUEUE_JOB_ATTEMPTS, // 最多尝试次数（包括第一次执行）
    //重试之间的延迟策略 如果错误是临时性（比如锁冲突、网络波动），用指数退避能减轻系统压力，避免疯狂重试。
    backoff: {
      type: "exponential", //每次重试的间隔时间按指数增长 第一次延迟delay毫秒 第二次延迟delay*2毫秒 第三次延迟delay*3毫秒 以此类推
      delay: Number(process.env.MEDIA_UPLOAD_JOB_BACKOFF_DELAY || 1000),
    },
    removeOnComplete: true, //任务执行成功后，BullMQ 会自动从 Redis 里删除任务记录。避免 Redis 队列数据无限增长，占用内存。
    removeOnFail: 1000, //任务失败后，BullMQ 只保留最近 1000 条失败任务，超过就自动删掉旧的。失败任务日志有限保留，方便排查，但不让 Redis 压力过大。
  },
});

function closeMediaUploadQueue() {
  return Promise.resolve()
    .then(() => mediaUploadQueue.close())
    .catch(() => {})
    .then(() => connection.quit?.())
    .catch(() => {});
}

module.exports = { mediaUploadQueue, queueConnection: connection, closeMediaUploadQueue };
