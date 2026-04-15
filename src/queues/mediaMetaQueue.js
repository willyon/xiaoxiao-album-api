/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 17:02:19
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:08:51
 * @Description: File description
 */
const { Queue } = require('bullmq')
const IORedis = require('ioredis')
const { QUEUE_JOB_ATTEMPTS, QUEUE_JOB_BACKOFF_DELAY } = require('../config/queueConfig')

const connection = new IORedis({
  maxRetriesPerRequest: null
})

const mediaMetaQueue = new Queue(process.env.MEDIA_META_QUEUE_NAME || 'media-meta', {
  connection,
  defaultJobOptions: {
    attempts: QUEUE_JOB_ATTEMPTS, // 最多尝试次数（包括第一次执行）
    backoff: {
      type: 'exponential', //每次重试的间隔时间按指数增长 第一次延迟delay毫秒 第二次延迟delay*2毫秒 第三次延迟delay*3毫秒 以此类推
      delay: QUEUE_JOB_BACKOFF_DELAY
    },
    removeOnComplete: true,
    removeOnFail: 200
  }
})

async function closeMediaMetaQueue() {
  await mediaMetaQueue.close()
  await connection.quit()
}

module.exports = { mediaMetaQueue, closeMediaMetaQueue }
