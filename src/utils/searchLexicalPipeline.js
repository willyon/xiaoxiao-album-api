/*
 * @Description: 搜索词法链路公共编排（分段、切片、种子提取与停用词过滤）
 */
const { tryCreateJieba, SEARCH_TERMS_SPLIT_REGEX } = require('./chineseSegmenter')
const { HAS_CJK } = require('./cjkRegex')
const { isOnlyPunctOrSpace } = require('./textTokenUtils')
const { isStopWordWholeSegment } = require('./embeddingLexicalGate')

/**
 * 连续 CJK、连续 [A-Za-z0-9]（含 iPhone15 类混合）拆成相邻片段；标点等不入片段。
 * @param {string} s - 原始文本。
 * @returns {string[]} 分段结果。
 */
function splitCjkAndAlnumRuns(s) {
  const runs = []
  let buf = ''
  /** @type {"cjk" | "alnum" | null} */
  let mode = null
  const flush = () => {
    if (buf) {
      runs.push(buf)
      buf = ''
      mode = null
    }
  }
  for (const ch of String(s || '')) {
    const isCjk = HAS_CJK.test(ch)
    const isAlnum = /[A-Za-z0-9]/.test(ch)
    if (isCjk) {
      if (mode === 'alnum') flush()
      mode = 'cjk'
      buf += ch
    } else if (isAlnum) {
      if (mode === 'cjk') flush()
      mode = 'alnum'
      buf += ch
    } else {
      flush()
    }
  }
  flush()
  return runs
}

/**
 * 按搜索分隔符拆分片段。
 * @param {string} run - 待拆分片段。
 * @returns {string[]} 拆分后的子片段。
 */
function splitBySearchDelimiters(run) {
  return String(run || '')
    .split(SEARCH_TERMS_SPLIT_REGEX)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * 按空白切分片段。
 * @param {string} text - 原始文本。
 * @returns {string[]} 切分后的片段。
 */
function splitByWhitespace(text) {
  return String(text || '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * 计算字符串码点长度。
 * @param {string} s - 输入字符串。
 * @returns {number} 码点长度。
 */
function countCodePoints(s) {
  return Array.from(String(s || '')).length
}

/**
 * 判断是否为纯 ASCII 字母数字串。
 * @param {string} s - 输入字符串。
 * @returns {boolean} 是否纯字母数字。
 */
function isPureAsciiAlnum(s) {
  return /^[A-Za-z0-9]+$/.test(String(s || ''))
}

/**
 * 英文/数字片：整段保留（小写）；中文片：码点长度 > 2 则 jieba，否则整段。
 * @param {string} piece - 待切分片段。
 * @returns {string[]} 词种子列表。
 */
function slicePieceToSeeds(piece) {
  const trimmed = String(piece || '').trim()
  if (!trimmed) return []
  if (isPureAsciiAlnum(trimmed)) {
    return [trimmed.toLowerCase()]
  }
  if (countCodePoints(trimmed) <= 2) {
    return [trimmed]
  }
  const jieba = tryCreateJieba()
  if (!jieba) {
    return [trimmed]
  }
  const parts = jieba.cutForSearch(trimmed, true)
  const out = []
  for (const w of parts) {
    const t = w.trim()
    if (!t || isOnlyPunctOrSpace(t)) continue
    out.push(/^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t)
  }
  return out.length > 0 ? out : [trimmed]
}

/**
 * 仅含 CJK 的种子若整段为停用词则剔除；纯英文/数字种子不比 stop 表。
 * @param {string[]} seeds - 种子列表。
 * @returns {string[]} 过滤后的种子列表。
 */
function dropChineseStopSeeds(seeds) {
  const out = []
  for (const s of seeds || []) {
    if (!s) continue
    if (HAS_CJK.test(s) && isStopWordWholeSegment(s)) continue
    out.push(s)
  }
  return out
}

/**
 * 从 residual 构建去重种子列表（供视觉门闩与检索链路复用）。
 * @param {string} residual - residual 文本。
 * @returns {string[]} 去重后的种子列表。
 */
function buildLexicalSeedsFromResidual(residual) {
  const raw = String(residual || '').trim()
  if (!raw) return []
  const seedSet = new Set()
  for (const run of splitCjkAndAlnumRuns(raw)) {
    for (const piece of splitBySearchDelimiters(run)) {
      for (const seed of slicePieceToSeeds(piece)) {
        if (seed) seedSet.add(seed)
      }
    }
  }
  return [...seedSet]
}

module.exports = {
  splitBySearchDelimiters,
  splitByWhitespace,
  buildLexicalSeedsFromResidual,
  dropChineseStopSeeds
}
