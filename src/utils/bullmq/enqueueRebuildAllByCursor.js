/**
 * 通用「按 id 游标分页 + addBulk 入队 + 迭代封顶日志」执行器。
 *
 * @param {object} options - 入队执行参数。
 * @param {number} options.limitPerBatch - 单批处理上限。
 * @param {number|string} options.userId - 用户 ID。
 * @param {(limitPerBatch:number, userId:number|string, cursorBeforeId:number|null)=>any[]} options.selectBatch - 批量查询函数。
 * @param {(row:any)=>{name:string,data:object,opts?:object}} options.buildJob - Job 构建函数。
 * @param {(jobs:any[])=>Promise<any>} options.addBulk - 批量入队函数。
 * @param {(userId:number|string)=>number} options.countPending - 统计待处理数量函数。
 * @param {string} options.logLabel - 日志标签。
 * @param {string} options.maxIterEnvKey - 最大迭代环境变量名。
 * @param {import('../logger')} options.logger - 日志器。
 * @returns {Promise<number>} 实际入队数量。
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
