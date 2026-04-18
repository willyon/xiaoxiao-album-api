/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 17:02:19
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:08:51
 * @Description: File description
 */
const { createBullQueue } = require('../utils/bullmq/createBullQueue')
const logger = require('../utils/logger')
const { closeBullResources } = require('../utils/bullmq/closeBullResources')

const { queue: mediaMetaQueue, connection } = createBullQueue({
  name: process.env.MEDIA_META_QUEUE_NAME || 'media-meta'
})

/**
 * 关闭 meta 队列及其 Redis 连接。
 * @returns {Promise<void>} 无返回值。
 */
async function closeMediaMetaQueue() {
  await closeBullResources({ queue: mediaMetaQueue, connection, logger, label: 'mediaMetaQueue' })
}

module.exports = { mediaMetaQueue, closeMediaMetaQueue }
