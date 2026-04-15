/*
 * @Description: `getCoreTokensOnlyForResidual`（视觉 FTS）：对 residual jieba 分词后仅剔除全词 SEARCH_NOISE_TERMS；core 为空则不做 FTS。不含同义词扩展（同义词见短句 terms、`visualEmbeddingLexicalGate`）。
 *
 * `passLexicalGate` 用于向量补召回的字面校验；词表由 `visualEmbeddingLexicalGate.buildVisualEmbeddingGateLexicalTokens` 传入。
 *
 * 英文纯 ASCII token 先 lowerCase 再与 SEARCH_NOISE_TERMS 比对。
 */
const { segmentFieldForSearchTerms } = require('./chineseSegmenter')
const { SEARCH_ACTION_TERMS } = require('../config/searchActionTerms')

/** 中文：单字虚词 + 二字及以上功能词；与分词结果全词匹配则剔除 */
const SEARCH_NOISE_TERMS = new Set([
  // --- 单字虚词 / 介助 / 代词（显式列出）
  '的',
  '了',
  '着',
  '在',
  '和',
  '与',
  '或',
  '及',
  '把',
  '被',
  '给',
  '从',
  '向',
  '往',
  '到',
  '对',
  '为',
  '以',
  '于',
  '由',
  '将',
  '是',
  '有',
  '就',
  '也',
  '还',
  '又',
  '都',
  '才',
  '只',
  '很',
  '太',
  '更',
  '最',
  '挺',
  '真',
  '好',
  '多',
  '少',
  '不',
  '没',
  '未',
  '别',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '哦',
  '嗯',
  '啦',
  '哇',
  '哈',
  '唉',
  '哟',
  '嘛',
  '呗',
  '地',
  '得',
  '所',
  '之',
  '其',
  '某',
  '各',
  '每',
  '这',
  '那',
  '哪',
  '啥',
  '您',
  '你',
  '我',
  '他',
  '她',
  '它',
  '咱',
  '们',
  '等',
  // --- 二字及以上：代词与指代
  '我们',
  '你们',
  '他们',
  '她们',
  '它们',
  '自己',
  '人家',
  '大家',
  '彼此',
  '各位',
  '什么',
  '怎么',
  '怎样',
  '如何',
  '为何',
  '哪里',
  '哪儿',
  '这边',
  '那边',
  '这里',
  '那里',
  '这些',
  '那些',
  '这个',
  '那个',
  '这样',
  '那样',
  '如此',
  '某样',
  '其它',
  '其他',
  '其余',
  '某个',
  '某些',
  '各种',
  '各自',
  '一切',
  '所有',
  '每个',
  // 数量与程度（泛化）
  '一个',
  '一些',
  '一点',
  '一下',
  '一直',
  '一定',
  '许多',
  '不少',
  '很多',
  '非常',
  '比较',
  '更加',
  '特别',
  '尤其',
  '十分',
  '相当',
  '极其',
  '有点',
  '有些',
  // 连词与逻辑
  '但是',
  '然而',
  '不过',
  '而且',
  '并且',
  '或者',
  '还是',
  '以及',
  '要么',
  '因此',
  '所以',
  '因为',
  '如果',
  '虽然',
  '于是',
  '然后',
  '接着',
  '同时',
  '另外',
  '此外',
  '总之',
  '即便',
  '除非',
  // 能愿与判断套话
  '可以',
  '能够',
  '应该',
  '需要',
  '必须',
  '得以',
  '是否',
  '有没有',
  '是不是',
  '要不要',
  '能不能',
  '会不会',
  '可不可以',
  // 介词类常见双音节
  '关于',
  '对于',
  '至于',
  '根据',
  '按照',
  '通过',
  '为了',
  '除了',
  '有关',
  // 时间状态（弱约束）
  '正在',
  '将要',
  '快要',
  '已经',
  '曾经',
  '仍然',
  '依然',
  '本来',
  '原来',
  '其实',
  '果然',
  '终于',
  '马上',
  '立刻',
  '忽然',
  '突然',
  '渐渐',
  '慢慢',
  '匆匆',
  // 结构补片
  '的话',
  '而言',
  '来说',
  '之一',
  '似的',
  '与否',
  // 媒体形态泛词（弱语义，作为查询噪声处理）
  '照片',
  '视频'
])

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
 * @param {string[]} tokens - 扩展后的字面词表（如 `visualEmbeddingLexicalGate.buildVisualEmbeddingGateLexicalTokens`）
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
  normalizeStopWordLookupKey,
  isStopWordWholeSegment,
  extractActionGroups,
  calcRequiredGroupHits,
  passLexicalGate,
  /** 检索噪声词（含传统停用词与业务噪声词），供外部复用。 */
  SEARCH_NOISE_TERMS
}
