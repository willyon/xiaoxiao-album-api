/**
 * 搜索结果媒体拉取层：负责按 ID 分块查询与按排序结果稳定分页取数。
 */
const searchModel = require('../../models/mediaModel')

// SQLite 单语句绑定变量有上限（常见为 999），大批量 id 的 IN 查询需分批。
const SQLITE_IN_CLAUSE_CHUNK = 900

/**
 * 按 SQLite IN 子句上限分块查询媒体详情。
 * @param {number} userId 用户 ID
 * @param {number[]} imageIds 媒体 ID 列表
 * @returns {any[]} 媒体详情数组
 */
function fetchMediasByIdsChunked(userId, imageIds) {
  if (!imageIds.length) return []
  const rows = []
  for (let i = 0; i < imageIds.length; i += SQLITE_IN_CLAUSE_CHUNK) {
    rows.push(
      ...searchModel.getMediasByIds({
        userId,
        imageIds: imageIds.slice(i, i + SQLITE_IN_CLAUSE_CHUNK)
      })
    )
  }
  return rows
}

/**
 * 按 rankedIds 顺序从 offset 起凑满一页；跳过已删除/不可见的媒体，避免缓存命中后出现空洞。
 * @param {number} userId 用户 ID
 * @param {number[]} rankedIds 已排序媒体 ID 列表
 * @param {number} offset 偏移量
 * @param {number} pageSize 页大小
 * @returns {any[]} 当前页媒体数组
 */
function buildOrderedPageMedias(userId, rankedIds, offset, pageSize) {
  const list = []
  let readHead = offset
  while (list.length < pageSize && readHead < rankedIds.length) {
    const remaining = rankedIds.length - readHead
    const batchLen = Math.min(SQLITE_IN_CLAUSE_CHUNK, remaining, Math.max(pageSize - list.length + 24, pageSize))
    const batchIds = rankedIds.slice(readHead, readHead + batchLen)
    readHead += batchLen
    const rows = fetchMediasByIdsChunked(userId, batchIds)
    const map = new Map(rows.map((item) => [item.mediaId, item]))
    for (const id of batchIds) {
      const row = map.get(id)
      if (row) {
        list.push(row)
        if (list.length >= pageSize) return list
      }
    }
  }
  return list
}

module.exports = {
  fetchMediasByIdsChunked,
  buildOrderedPageMedias
}
