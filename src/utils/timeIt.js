/*
 * @Author: zhangshouchang
 * @Date: 2025-08-17 10:41:21
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:11:34
 * @Description: File description
 */
// 放在各文件顶部（worker/ingestor/hashset都可复用）
const logger = require('../utils/logger')
const { performance } = require('perf_hooks')
const PROFILE = process.env.PROFILE_UPLOAD === '1'

// const times = [];

/**
 * 获取高精度当前时间戳（毫秒）。
 * @returns {number} 当前时间戳。
 */
function tNow() {
  return performance.now()
}

// function mark(label, ms) {
//   times.push({ label, ms: Math.round(ms) });
// }

// 异步计时器：await timeIt('标签', async () => { ... })
/**
 * 对异步函数执行耗时打点。
 * @param {string} label - 打点标签。
 * @param {() => Promise<any>} fn - 待执行异步函数。
 * @param {string} [imageHash] - 关联媒体哈希（可选）。
 * @returns {Promise<any>} 原函数返回值。
 */
async function timeIt(label, fn, imageHash) {
  const s = tNow()
  const ret = await fn()
  const ms = tNow() - s
  if (PROFILE) {
    logger.info({ message: `[埋点计时]${label}:jobId:${imageHash || 0}:${ms}毫秒` })
  }
  return ret
}

module.exports = timeIt
