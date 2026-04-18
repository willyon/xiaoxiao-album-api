/**
 * 将输入列表规范化为数字 ID 列表（仅保留有限数字）。
 * @param {Array<string|number>} ids - 原始 ID 列表。
 * @returns {number[]} 规范化后的数字 ID。
 */
function normalizeNumericIds(ids) {
  if (!Array.isArray(ids)) return []
  return ids
    .map((value) => {
      const numeric = Number(value)
      return Number.isFinite(numeric) ? numeric : null
    })
    .filter((value) => value !== null)
}

module.exports = {
  normalizeNumericIds
}
