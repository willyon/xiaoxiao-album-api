/**
 * 通用「按 id 游标分页 + addBulk 入队 + 迭代封顶日志」执行器。
 *
 * @param {Object} options
 * @param {number} options.limitPerBatch
 * @param {number|string} options.userId
 * @param {(limitPerBatch:number, userId:number|string, cursorBeforeId:number|null)=>any[]} options.selectBatch
 * @param {(row:any)=>{name:string,data:Object,opts?:Object}} options.buildJob
 * @param {(jobs:any[])=>Promise<any>} options.addBulk
 * @param {(userId:number|string)=>number} options.countPending
 * @param {string} options.logLabel
 * @param {string} options.maxIterEnvKey
 * @param {import('./logger')} options.logger
 * @returns {Promise<number>}
 */
async function enqueueRebuildAllByCursor({
  limitPerBatch = 500,
  userId,
  selectBatch,
  buildJob,
  addBulk,
  countPending,
  logLabel,
  maxIterEnvKey,
  logger
}) {
  const envIter = Number(process.env[maxIterEnvKey])
  const maxIter = Math.max(1, Math.min(Number.isFinite(envIter) && envIter > 0 ? envIter : 40, 100_000_000))
  let totalEnqueued = 0
  let cursorBeforeId = null

  for (let i = 0; i < maxIter; i++) {
    const rows = selectBatch(limitPerBatch, userId, cursorBeforeId)
    if (!rows || rows.length === 0) {
      return totalEnqueued
    }

    const jobs = rows.map((row) => buildJob(row))
    await addBulk(jobs)
    totalEnqueued += rows.length
    cursorBeforeId = rows[rows.length - 1].mediaId
  }

  const pendingLeft = countPending(userId)
  logger.error({
    message: `${logLabel}: iteration cap reached (check ${maxIterEnvKey})`,
    totalEnqueued,
    pendingLeft,
    maxIter,
    limitPerBatch
  })
  return totalEnqueued
}

module.exports = {
  enqueueRebuildAllByCursor
}
