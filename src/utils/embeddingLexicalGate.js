/*
 * @Description: `getCoreTokensOnlyForResidual`（视觉 FTS）：对 residual jieba 分词后仅剔除全词 SEARCH_NOISE_TERMS；core 为空则不做 FTS。不含同义词扩展（同义词见短句 terms、`visualEmbeddingLexicalGate`）。
 *
 * `passLexicalGate` 用于向量补召回的字面校验；词表由 `visualEmbeddingLexicalGate.buildVisualEmbeddingGateLexicalSpec` 的 `tokens` 传入。
 *
 * 英文纯 ASCII token 先 lowerCase 再与 SEARCH_NOISE_TERMS 比对。
 */
const { segmentFieldForSearchTerms } = require('./chineseSegmenter')
const { SEARCH_ACTION_TERMS } = require('../config/searchActionTerms')
const { SEARCH_NOISE_TERMS } = require('../config/searchNoiseTerms')

const ACTION_TERMS = new Set((SEARCH_ACTION_TERMS || []).map((t) => normalizeStopWordLookupKey(t)).filter(Boolean))

/** 与 SEARCH_NOISE_TERMS 比对用的 key：纯 ASCII 整段则小写，否则原样（trim 后）。 */
function normalizeStopWordLookupKey(s) {
  const t = String(s || '').trim()
  if (!t) return ''
  return /^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t
}

/** 整段是否应视为噪声词：空/空白视为是；否则按 key 命中 SEARCH_NOISE_TERMS（短句 terms 切段丢弃、向量门闩 CJK 种子等可复用）。 */
function isStopWordWholeSegment(segment) {
  const t = String(segment || '').trim()
  if (!t) return true
  return SEARCH_NOISE_TERMS.has(normalizeStopWordLookupKey(t))
}

/** 仅剔除 SEARCH_NOISE_TERMS；供视觉 FTS MATCH 拼串 */
function filterStopWordsFromTokens(tokens) {
  return (tokens || []).filter((t) => {
    if (!t) return false
    const s = String(t).trim()
    if (!s) return false
    return !SEARCH_NOISE_TERMS.has(normalizeStopWordLookupKey(s))
  })
}

/** residual → 分词 → 仅剔除 SEARCH_NOISE_TERMS → 供视觉 FTS 拼串（不含同义词）；若为空则不做 FTS */
function getCoreTokensOnlyForResidual(residual) {
  const raw = String(residual || '').trim()
  if (!raw) {
    return []
  }
  return filterStopWordsFromTokens(segmentFieldForSearchTerms(raw))
}

function extractActionGroups(groups) {
  const out = []
  for (const group of groups || []) {
    const list = Array.isArray(group) ? group : []
    const normalized = list.map((t) => String(t || '').trim()).filter(Boolean)
    if (normalized.length === 0) continue
    const hasAction = normalized.some((token) => ACTION_TERMS.has(normalizeStopWordLookupKey(token)))
    if (hasAction) out.push(normalized)
  }
  return out
}

function calcRequiredGroupHits(groupCount) {
  const n = Number(groupCount) || 0
  if (n <= 0) return 0
  if (n <= 2) return 1
  return Math.min(n - 1, 3)
}

function groupMatched(text, group) {
  for (const token of group || []) {
    const t = String(token || '').toLowerCase()
    if (!t) continue
    if (text.includes(t)) return true
  }
  return false
}

/**
 * @param {string} descriptionText - media_search.description_text
 * @param {string[]} tokens - 扩展后的字面词表（如 `buildVisualEmbeddingGateLexicalSpec(residual).tokens`）
 * @returns {boolean}
 */
function passLexicalGate(descriptionText, tokens, options = {}) {
  const { minHits = 1, actionTokens = [], synonymGroups = [], requiredGroupHits = null, actionGroups = [] } = options || {}
  if (!tokens || tokens.length === 0) {
    // 无可校验词则纯向量补召回一律不通过（避免仅剩虚词/弱动词时无边界放行）
    return false
  }
  const text = String(descriptionText || '').toLowerCase()
  const matched = new Set()
  for (const token of tokens) {
    if (!token) continue
    const t = String(token).toLowerCase()
    if (!t) continue
    if (text.includes(t)) matched.add(t)
  }
  if (matched.size < Math.max(1, Number(minHits) || 1)) {
    return false
  }
  if (Array.isArray(synonymGroups) && synonymGroups.length > 0) {
    const required = Number.isFinite(requiredGroupHits) ? Math.max(1, Number(requiredGroupHits)) : calcRequiredGroupHits(synonymGroups.length)
    let hitGroups = 0
    for (const group of synonymGroups) {
      if (groupMatched(text, group)) hitGroups += 1
    }
    if (hitGroups < required) return false
  }
  if (Array.isArray(actionGroups) && actionGroups.length > 0) {
    const hasActionGroupHit = actionGroups.some((group) => groupMatched(text, group))
    if (!hasActionGroupHit) return false
  } else if (Array.isArray(actionTokens) && actionTokens.length > 0) {
    const hasActionHit = actionTokens.some((token) => {
      if (!token) return false
      return matched.has(String(token).toLowerCase())
    })
    if (!hasActionHit) return false
  }
  return true
}

module.exports = {
  getCoreTokensOnlyForResidual,
  isStopWordWholeSegment,
  extractActionGroups,
  calcRequiredGroupHits,
  passLexicalGate
}
