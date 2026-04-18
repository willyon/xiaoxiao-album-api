/*
 * @Description: 检索用同义词扩展：正向表 + 反向索引（value → 所属 key）
 * 性能：反向 Map 首次调用时构建一次（O(词条总数)）；每次查询对种子词做 O(种子数×均摊) 的 Set 合并，表规模小可忽略。
 * 复用：短句视觉 term、`visualEmbeddingLexicalGate`（向量门闩同义扩展）共用本模块。
 */
const { SEARCH_LEXICAL_SYNONYMS } = require('../config/searchLexicalSynonyms')

/** @type {Map<string, Set<string>> | null} */
let reverseSynonymIndex = null

/**
 * 构建反向同义词索引：value -> key 集合。
 * @returns {Map<string, Set<string>>} 反向索引。
 */
function buildReverseSynonymIndex() {
  const rev = new Map()
  for (const [key, syns] of Object.entries(SEARCH_LEXICAL_SYNONYMS)) {
    if (!key || !Array.isArray(syns)) continue
    for (const s of syns) {
      const v = String(s || '').trim()
      if (!v) continue
      if (!rev.has(v)) rev.set(v, new Set())
      rev.get(v).add(key)
    }
  }
  return rev
}

/**
 * 获取（或惰性初始化）反向同义词索引。
 * @returns {Map<string, Set<string>>} 反向索引。
 */
function getReverseSynonymIndex() {
  if (!reverseSynonymIndex) {
    reverseSynonymIndex = buildReverseSynonymIndex()
  }
  return reverseSynonymIndex
}

/**
 * 为单个种子词构建同义词组（含正向与反向桥接）。
 * @param {string} seed - 种子词。
 * @returns {string[]} 同义词组。
 */
function buildSynonymGroupForSeed(seed) {
  const base = String(seed || '').trim()
  if (!base) return []
  const forward = SEARCH_LEXICAL_SYNONYMS
  const reverse = getReverseSynonymIndex()
  const out = new Set([base])
  const list = forward[base]
  if (Array.isArray(list)) {
    list.forEach((x) => {
      const v = String(x || '').trim()
      if (v) out.add(v)
    })
  }
  const keys = reverse.get(base)
  if (keys && keys.size > 0) {
    for (const k of keys) {
      const kk = String(k || '').trim()
      if (!kk) continue
      out.add(kk)
      const syns = forward[kk]
      if (Array.isArray(syns)) {
        syns.forEach((x) => {
          const v = String(x || '').trim()
          if (v) out.add(v)
        })
      }
    }
  }
  return Array.from(out)
}

/**
 * 为多种子词构建同义词分组。
 * @param {string[]} seedTerms - 种子词列表。
 * @returns {string[][]} 同义词分组列表。
 */
function buildSynonymGroups(seedTerms) {
  const seeds = [...new Set((seedTerms || []).map((t) => String(t || '').trim()).filter(Boolean))]
  return seeds.map((seed) => buildSynonymGroupForSeed(seed)).filter((g) => g.length > 0)
}

/**
 * 由种子词展开：种子 ∪ 正向同义词 ∪（种子命中某 value 时并入对应 key 及其同义词）
 * @param {string[]} seedTerms - 种子词列表。
 * @returns {string[]} 去重后的扩展词列表。
 */
function expandTermsWithSynonyms(seedTerms) {
  const seeds = [...new Set(seedTerms.map((t) => String(t || '').trim()).filter(Boolean))]
  const out = new Set(seeds)
  const forward = SEARCH_LEXICAL_SYNONYMS
  const reverse = getReverseSynonymIndex()

  for (const seed of seeds) {
    const list = forward[seed]
    if (Array.isArray(list)) {
      list.forEach((x) => {
        const v = String(x || '').trim()
        if (v) out.add(v)
      })
    }
    const keys = reverse.get(seed)
    if (keys && keys.size > 0) {
      for (const k of keys) {
        if (k) out.add(k)
        const syns = forward[k]
        if (Array.isArray(syns)) {
          syns.forEach((x) => {
            const v = String(x || '').trim()
            if (v) out.add(v)
          })
        }
      }
    }
  }
  return Array.from(out)
}

module.exports = {
  expandTermsWithSynonyms,
  buildSynonymGroups
}
