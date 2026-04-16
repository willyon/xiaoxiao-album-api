/**
 * OCR 召回层：负责将用户输入转换为 OCR LIKE 检索并写入候选集分值。
 */
const searchModel = require('../../models/mediaModel')
const { scoreOcrTextLikeHits } = require('./searchCandidateScoring')

/** 用户输入 → LOWER 后对 SQLite LIKE 转义 % _ \\，再包前后 %（与 recallMediaIdsByOcrTextLike 的 ESCAPE '\\\\' 配合）。 */
/**
 * 构建 OCR LIKE 查询模式串（含转义）。
 * @param {string} segment 原始检索片段
 * @returns {string|null} LIKE 模式串；为空时返回 null
 */
function buildOcrTextLikePattern(segment) {
  const raw = String(segment || '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  const escaped = lower.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  return `%${escaped}%`
}

/**
 * OCR：`segment` 按空白切分为多段，每段各自对 `ocr_text` 做 LOWER + LIKE；结果按 media_id **并集去重**（任一一段命中即纳入）。
 * 无空白时等价于整句一次 LIKE。英文不区分大小写。
 * @param {{segment:string, userId:number, whereConditions:string[], whereParams:any[]}} params OCR 召回参数
 * @param {Map<number, any>} segCands 当前段候选集
 * @returns {{likeRows:number}} 命中行数统计
 */
function applyOcrRecallForSegment({ segment, userId, whereConditions, whereParams }, segCands) {
  const trimmed = String(segment || '').trim()
  if (!trimmed) {
    return { likeRows: 0 }
  }
  const chunks = trimmed.split(/\s+/).filter(Boolean)
  const byId = new Map()
  for (const chunk of chunks) {
    const likePattern = buildOcrTextLikePattern(chunk)
    if (!likePattern) continue
    const rows = searchModel.recallMediaIdsByOcrTextLike({
      userId,
      likePattern,
      whereConditions,
      whereParams
    })
    for (const row of rows) {
      const mediaId = Number(row.media_id)
      if (!Number.isFinite(mediaId)) continue
      if (!byId.has(mediaId)) {
        byId.set(mediaId, row)
      }
    }
  }
  const ocrRows = Array.from(byId.values())
  scoreOcrTextLikeHits(segCands, ocrRows)
  return { likeRows: ocrRows.length }
}

module.exports = {
  applyOcrRecallForSegment
}
