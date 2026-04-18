/*
 * @Description: 视觉文本向量字面门闩用词（与 docs/视觉文本向量搜索链路说明.md §9 一致）
 * residual.trim() → 词法编排（分段/切片/种子）→ 仅含中文种子剔 SEARCH_NOISE_TERMS → expandTermsWithSynonyms
 * 不涉及 WEAK_VERBS；query 向量仍用全文 residual.trim()（searchService 侧）。
 */
const { buildLexicalSeedsFromResidual, dropChineseStopSeeds } = require('./searchLexicalPipeline')
const { buildSynonymGroups } = require('./searchSynonymExpansion')

/**
 * 构建视觉向量门闩的词法匹配规格。
 * @param {string} residual - residual 查询文本。
 * @returns {{seeds:string[],groups:string[][],tokens:string[]}} 门闩词法规格。
 */
function buildVisualEmbeddingGateLexicalSpec(residual) {
  const seeds = buildLexicalSeedsFromResidual(residual)
  if (seeds.length === 0) {
    return {
      seeds: [],
      groups: [],
      tokens: []
    }
  }
  const filtered = dropChineseStopSeeds(seeds)
  const groups = buildSynonymGroups(filtered)
  const tokenSet = new Set()
  groups.forEach((group) => {
    group.forEach((token) => {
      const t = String(token || '').trim()
      if (t) tokenSet.add(t)
    })
  })
  return {
    seeds: filtered,
    groups,
    tokens: Array.from(tokenSet)
  }
}

module.exports = {
  buildVisualEmbeddingGateLexicalSpec
}
