/*
 * @Author: zhangshouchang
 * @Date: 2025-08-17 10:41:21
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:11:34
 * @Description: File description
 */
// 放在各文件顶部（worker/ingestor/hashset都可复用）
const logger = require("../utils/logger");
const { performance } = require("perf_hooks");
const PROFILE = process.env.PROFILE_UPLOAD === "1";

// const times = [];

function tNow() {
  return performance.now();
}

// function mark(label, ms) {
//   times.push({ label, ms: Math.round(ms) });
// }

// 异步计时器：await timeIt('标签', async () => { ... })
async function timeIt(label, fn, imageHash) {
  let ret;
  try {
    const s = tNow();
    console.log("这里开始啦", label, s);
    ret = await fn();
    const ms = tNow() - s;
    console.log("这里执行完啦", label, ms, "毫秒");
    if (PROFILE) {
      logger.info({ message: `[埋点计时]${label}:jobId:${imageHash || 0}:${ms}毫秒` });
    }
  } catch (error) {
    throw error;
  }
  return ret;
}

module.exports = timeIt;
