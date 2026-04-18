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

/**
 * 规范化停用词匹配键。
 * @param {string} s - 原始词项。
 * @returns {string} 规范化匹配键。
 */
function normalizeStopWordLookupKey(s) {
  const t = String(s || '').trim()
  if (!t) return ''
  return /^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t
}

/**
 * 判断整段文本是否为停用词。
 * @param {string} segment - 待判断文本。
 * @returns {boolean} 是否为停用词。
 */
function isStopWordWholeSegment(segment) {
  const t = String(segment || '').trim()
  if (!t) return true
  return SEARCH_NOISE_TERMS.has(normalizeStopWordLookupKey(t))
}

/**
 * 从 tokens 中移除停用词。
 * @param {string[]} tokens - 词项列表。
 * @returns {string[]} 过滤后的词项列表。
 */
function filterStopWordsFromTokens(tokens) {
  return (tokens || []).filter((t) => {
    if (!t) return false
    const s = String(t).trim()
    if (!s) return false
    return !SEARCH_NOISE_TERMS.has(normalizeStopWordLookupKey(s))
  })
}

/**
 * 从 residual 文本提取核心词项。
 * @param {string} residual - residual 查询文本。
 * @returns {string[]} 核心词项列表。
 */
function getCoreTokensOnlyForResidual(residual) {
  const raw = String(residual || '').trim()
  if (!raw) {
    return []
  }
  return filterStopWordsFromTokens(segmentFieldForSearchTerms(raw))
}

/**
 * 提取包含动作词的同义词组。
 * @param {Array<string[]>} groups - 同义词分组。
 * @returns {Array<string[]>} 动作相关分组。
 */
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

/**
 * 计算同义词分组最小命中数要求。
 * @param {number} groupCount - 分组总数。
 * @returns {number} 最小命中分组数。
 */
function calcRequiredGroupHits(groupCount) {
  const n = Number(groupCount) || 0
  if (n <= 0) return 0
  if (n <= 2) return 1
  return Math.min(n - 1, 3)
}

/**
 * 判断文本是否命中某个词组。
 * @param {string} text - 待匹配文本。
 * @param {string[]} group - 词组。
 * @returns {boolean} 是否命中。
 */
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
 * @param {{minHits?:number,actionTokens?:string[],synonymGroups?:Array<string[]>,requiredGroupHits?:number|null,actionGroups?:Array<string[]>}} [options={}] - 门闩选项。
 * @returns {boolean} 是否通过字面门闩。
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
