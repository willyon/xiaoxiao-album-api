/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 17:02:19
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:08:51
 * @Description: File description
 */
const { createBullQueue } = require('../utils/bullmq/createBullQueue')

const { queue: mediaMetaQueue, connection } = createBullQueue({
  name: process.env.MEDIA_META_QUEUE_NAME || 'media-meta'
})

async function closeMediaMetaQueue() {
  await mediaMetaQueue.close()
  await connection.quit()
}

module.exports = { mediaMetaQueue, closeMediaMetaQueue }
