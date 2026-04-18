const { normalizeTextArray } = require('../../models/mediaModel/mediaLocationSql')

/**
 * 统一将 caption 模块结果转换为数据库可写字段。
 * @param {object} capData
 * @returns {object|null}
 */
function buildCaptionForDb(capData) {
  if (!capData || typeof capData !== 'object') return null
  const out = {}
  const desc = typeof capData.description === 'string' ? capData.description.trim() : ''
  if (desc) out.description = desc
  const kw = normalizeTextArray(capData.keywords)
  if (kw.length > 0) out.keywords = kw
  const st = normalizeTextArray(capData.subject_tags)
  if (st.length > 0) out.subjectTags = st
  const at = normalizeTextArray(capData.action_tags)
  if (at.length > 0) out.actionTags = at
  const sc = normalizeTextArray(capData.scene_tags)
  if (sc.length > 0) out.sceneTags = sc
  const ocr = typeof capData.ocr === 'string' ? capData.ocr.trim() : ''
  if (ocr) out.ocr = ocr
  if (typeof capData.face_count === 'number' && Number.isFinite(capData.face_count)) {
    out.faceCount = Math.max(0, Math.floor(capData.face_count))
  }
  if (typeof capData.person_count === 'number' && Number.isFinite(capData.person_count)) {
    out.personCount = Math.max(0, Math.floor(capData.person_count))
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 统一 cloud 状态映射。
 * @param {string|undefined} capStatus
 * @param {{cloudEnabled?:boolean}} options
 * @returns {'success'|'failed'|'skipped'}
 */
function mapCaptionModuleStatus(capStatus, { cloudEnabled = true } = {}) {
  if (!cloudEnabled) return 'skipped'
  return capStatus === 'success' ? 'success' : 'failed'
}

module.exports = {
  buildCaptionForDb,
  mapCaptionModuleStatus
}
