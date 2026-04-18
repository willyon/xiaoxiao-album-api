/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 16:38:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:10:58
 * @Description: 创建上传队列
 */
const { createBullQueue } = require('../utils/bullmq/createBullQueue')
const logger = require('../utils/logger')
const { closeBullResources } = require('../utils/bullmq/closeBullResources')

const { queue: mediaUploadQueue, connection } = createBullQueue({
  name: process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload'
})

/**
 * 关闭上传队列及 Redis 连接（记录失败日志，不抛出）。
 * @returns {Promise<void>} 无返回值。
 */
async function closeMediaUploadQueue() {
  await closeBullResources({ queue: mediaUploadQueue, connection, logger, label: 'mediaUploadQueue' })
}

module.exports = { mediaUploadQueue, closeMediaUploadQueue }
