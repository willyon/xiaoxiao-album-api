/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 16:38:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:10:58
 * @Description: 创建上传队列
 */
const { createBullQueue } = require('../utils/bullmq/createBullQueue')

const { queue: mediaUploadQueue, connection } = createBullQueue({
  name: process.env.MEDIA_UPLOAD_QUEUE_NAME || 'media-upload'
})

function closeMediaUploadQueue() {
  return Promise.resolve()
    .then(() => mediaUploadQueue.close())
    .catch(() => {})
    .then(() => connection.quit?.())
    .catch(() => {})
}

module.exports = { mediaUploadQueue, closeMediaUploadQueue }
