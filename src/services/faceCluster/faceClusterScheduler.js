/*
 * @Description: 人脸聚类调度器 - 使用去抖机制自动触发聚类
 * 在人脸识别完成后调用 scheduleUserClustering(userId)；去抖窗口内多次调用只执行一次。
 */

const logger = require('../../utils/logger')
const { createDebouncedUserScheduler } = require('../../utils/debouncedUserScheduler')
const { performFaceClustering } = require('./faceClusteringOrchestrator')

const DEBOUNCE_MS = Number(process.env.FACE_CLUSTERING_DEBOUNCE_MS || 1 * 60 * 1000)

const { schedule: scheduleUserClustering } = createDebouncedUserScheduler({
  debounceMs: DEBOUNCE_MS,
  async execute(userId) {
    try {
      logger.info({
        message: `开始执行自动人脸聚类: userId=${userId}`
      })

      const result = await performFaceClustering({
        userId,
        recluster: true
      })

      logger.info({
        message: `自动人脸聚类完成: userId=${userId}`,
        details: result
      })
    } catch (error) {
      logger.warn({
        message: `自动人脸聚类失败: userId=${userId}`,
        details: {
          error: error.message,
          stack: error.stack
        }
      })
    }
  }
})

module.exports = {
  scheduleUserClustering
}
