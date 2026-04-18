/**
 * 视觉召回层：负责 residual 相关的视觉 FTS、短词 terms、向量召回与词法门闩。
 */
const searchModel = require('../../models/mediaModel')
const { listVisualTextEmbeddingRowsForRecall } = require('../../models/mediaModel')
const { CHINESE_QUERY_TERM_BOOST } = require('../../config/searchRankingWeights')
const { containsChinese, segmentLengthUnits } = require('../../utils/searchTermUtils')
const { SANITIZE_FTS_TOKEN_CHAR_PATTERN } = require('../../utils/cjkRegex')
const { generateTextEmbeddingForQuery } = require('../embeddingProvider')
const { splitBySearchDelimiters } = require('../../utils/searchLexicalPipeline')
const {
  passLexicalGate,
  getCoreTokensOnlyForResidual,
  isStopWordWholeSegment,
  extractActionGroups,
  calcRequiredGroupHits
} = require('../../utils/embeddingLexicalGate')
const { expandTermsWithSynonyms } = require('../../utils/searchSynonymExpansion')
const { buildVisualEmbeddingGateLexicalSpec } = require('../../utils/visualEmbeddingLexicalGate')
const { scoreChineseTermHits, mergeFtsScores, mergeVisualSemanticScores, mergeCandidateMapsInto } = require('./searchCandidateScoring')

const _minSimParsed = parseFloat(process.env.VISUAL_EMBEDDING_MIN_SIMILARITY)
/** 与 query 向量点积（已归一化即余弦），低于则不进候选；默认 0.88，`.env` 的 VISUAL_EMBEDDING_MIN_SIMILARITY 覆盖 */
const VISUAL_EMBEDDING_MIN_SIMILARITY = Math.min(1, Math.max(0, Number.isFinite(_minSimParsed) ? _minSimParsed : 0.88))

const _topKParsed = parseInt(process.env.VISUAL_EMBEDDING_RECALL_TOP_K, 10)
/** 语义召回最多前 K 条；未设或无效则 null（不截断），`.env` 的 VISUAL_EMBEDDING_RECALL_TOP_K 设正整数可限制 */
const VISUAL_EMBEDDING_RECALL_TOP_K = Number.isFinite(_topKParsed) && _topKParsed > 0 ? _topKParsed : null

/** 图片理解 FTS：caption_search_terms 为 description/标签 等 jieba，不含 OCR/转写；OCR 检索单独走 ocr_text LIKE。 */
const VISUAL_FTS5_COLUMN_GROUP = '{description_text keywords_text subject_tags_text action_tags_text scene_tags_text caption_search_terms}'

/**
 * 对 FTS token 做安全清洗：允许字符直出，复杂字符转义为双引号 token。
 * @param {string} token 原始 token
 * @returns {string} 可用于 FTS 的 token
 */
function sanitizeFtsToken(token) {
  const value = String(token || '').trim()
  if (!value) return ''
  if (SANITIZE_FTS_TOKEN_CHAR_PATTERN.test(value)) {
    return value
  }
  return `"${value.replace(/"/g, '""')}"`
}

/** 长句视觉 FTS：已分好内容词时直接 sanitize 拼接，避免对整句再 jieba 一遍 */
/**
 * 将核心 token 列表拼成视觉 FTS 内层查询。
 * @param {string[]} coreTokens 核心 token 列表
 * @returns {string|null} 内层 FTS 查询
 */
function buildVisualFtsInnerFromCoreTokens(coreTokens) {
  const parts = (coreTokens || []).map((t) => sanitizeFtsToken(t)).filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

/** 向量查询文本：仅使用 core tokens，空则不查向量。 */
/**
 * 由核心 token 构造向量查询文本。
 * @param {string[]} coreTokens 核心 token 列表
 * @returns {string|null} 查询文本
 */
function buildEmbeddingQueryFromCoreTokens(coreTokens) {
  const parts = (coreTokens || []).map((t) => String(t || '').trim()).filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * 将内层 FTS 查询包装为仅视觉列匹配的查询。
 * @param {string} innerQuery 内层查询
 * @returns {string|null} 包装后的查询
 */
function wrapFtsQueryForVisualColumnsOnly(innerQuery) {
  const inner = String(innerQuery || '').trim()
  if (!inner) return null
  return `${VISUAL_FTS5_COLUMN_GROUP} : (${inner})`
}

/**
 * 计算两个向量的点积（向量已归一化时可视作余弦相似度）。
 * @param {number[]} [a=[]] 向量 A
 * @param {number[]} [b=[]] 向量 B
 * @returns {number} 点积结果
 */
function dotProduct(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0
  }
  let score = 0
  for (let i = 0; i < a.length; i += 1) {
    score += (Number(a[i]) || 0) * (Number(b[i]) || 0)
  }
  return score
}

/**
 * 视觉向量召回结果排序：相似度降序，media_id 降序。
 * @param {{media_id:number, similarity:number}} a - 结果 A。
 * @param {{media_id:number, similarity:number}} b - 结果 B。
 * @returns {number} 排序比较值。
 */
function compareVisualSimilarityRows(a, b) {
  return b.similarity - a.similarity || b.media_id - a.media_id
}

/**
 * 通过向量相似度召回媒体 ID 列表。
 * @param {{userId:number|string,queryText:string,whereConditions:string[],whereParams:any[],topK?:number}} [params={}] - 召回参数。
 * @returns {Promise<Array<{media_id:number, similarity:number, description_text:string}>>}
 */
function recallMediaIdsByVisualEmbedding({ userId, queryText, whereConditions, whereParams, topK } = {}) {
  const limit = topK !== undefined ? topK : VISUAL_EMBEDDING_RECALL_TOP_K
  const text = String(queryText || '').trim()
  if (!text) {
    return []
  }
  return generateTextEmbeddingForQuery(text).then((queryVector) => {
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      return []
    }
    const rows = listVisualTextEmbeddingRowsForRecall({
      userId,
      whereConditions,
      whereParams
    })
    const scored = []
    for (const row of rows) {
      const mediaId = Number(row.media_id)
      if (!Number.isFinite(mediaId)) continue
      const similarity = dotProduct(queryVector, row.vector || [])
      if (!Number.isFinite(similarity) || similarity < VISUAL_EMBEDDING_MIN_SIMILARITY) continue
      scored.push({
        media_id: mediaId,
        similarity,
        description_text: row.description_text
      })
    }
    scored.sort(compareVisualSimilarityRows)
    if (Number.isFinite(limit) && limit > 0) {
      return scored.slice(0, limit)
    }
    return scored
  })
}

/** 短句 terms：与 `chineseSegmenter` 分隔符一致，切段后多词 AND（每段内中文才做同义词扩展）。 */
/**
 * 将 residual 切分为短词检索片段。
 * @param {string} residual residual 文本
 * @returns {string[]} 切分后的片段
 */
function splitResidualSegmentsForShortTerms(residual) {
  const raw = String(residual || '').trim()
  if (!raw) return []
  return splitBySearchDelimiters(raw)
}

/**
 * 过滤掉纯停用词片段。
 * @param {string[]} segments 片段列表
 * @returns {string[]} 过滤后的片段列表
 */
function filterStopWordSegmentsForTerms(segments) {
  return (segments || []).filter((s) => s && !isStopWordWholeSegment(s))
}

/** 单段 → 同义词扩展后的 term 列表；仅中文扩展，英文/数字为小写单 token。 */
/**
 * 将单片段扩展成 terms（中文做同义词扩展，英文/数字转小写）。
 * @param {string} residualSegment 单片段 residual
 * @returns {string[]} 扩展后的 terms
 */
function expandSegmentTermsForChineseTermsAnd(residualSegment) {
  const seg = String(residualSegment || '').trim()
  if (!seg) return []
  if (containsChinese(seg)) {
    return expandTermsWithSynonyms([seg])
  }
  if (/^[\x00-\x7f]+$/.test(seg)) {
    return [seg.toLowerCase()]
  }
  return [seg]
}

/**
 * 求两个媒体 ID 集合交集。
 * @param {Set<number>} a 集合 A
 * @param {Set<number>} b 集合 B
 * @returns {Set<number>} 交集结果
 */
function intersectMediaIdSets(a, b) {
  const out = new Set()
  for (const id of a) {
    if (b.has(id)) out.add(id)
  }
  return out
}

/**
 * 仅图片理解：筛选 / 视觉列 FTS / 向量（任意 residual 长度都走 FTS + embedding）；短句额外走 term + 同义词。
 * @param {{segment:string, residual:string, hasStructured:boolean, userId:number, whereConditions:string[], whereParams:any[]}} params 视觉召回参数
 * @param {Map<number, any>} segCands 当前段候选集
 * @returns {Promise<{termRows:number, ftsRows:number, semanticRows:number}>} 召回统计
 */
async function applyVisualRecallForSegment({ segment, residual, hasStructured, userId, whereConditions, whereParams }, segCands) {
  let termRows = 0
  let ftsRows = 0
  let semanticRows = 0

  if (!residual && hasStructured) {
    const filterRows = searchModel.recallMediaIdsByFiltersOnly({
      userId,
      whereConditions,
      whereParams
    })
    mergeFtsScores(
      segCands,
      filterRows.map((r) => ({ media_id: r.media_id })),
      containsChinese(segment)
    )
    ftsRows += filterRows.length
  } else if (residual) {
    const residualUnits = segmentLengthUnits(residual)

    if (residualUnits <= 2) {
      const segments = filterStopWordSegmentsForTerms(splitResidualSegmentsForShortTerms(residual))
      const groups = segments.map((s) => expandSegmentTermsForChineseTermsAnd(s)).filter((g) => g.length > 0)

      if (groups.length > 0) {
        let allowedIds = null
        for (const terms of groups) {
          const rows = searchModel.recallMediaIdsByChineseTerms({
            userId,
            terms,
            whereConditions,
            whereParams
          })
          const ids = new Set()
          for (const r of rows) {
            const mid = Number(r.media_id)
            if (Number.isFinite(mid)) ids.add(mid)
          }
          allowedIds = allowedIds === null ? ids : intersectMediaIdSets(allowedIds, ids)
          if (allowedIds.size === 0) break
        }

        const allTermsFlat = [...new Set(groups.flat())]
        const queryTerms = allTermsFlat
          .map((term) => buildChineseQueryTermMeta(term))
          .sort(compareChineseQueryTermMeta)

        if (queryTerms.length > 0 && allowedIds && allowedIds.size > 0) {
          const termRowsDataAll = searchModel.recallMediaIdsByChineseTerms({
            userId,
            terms: queryTerms.map((item) => item.term),
            whereConditions,
            whereParams
          })
          const termRowsData = termRowsDataAll.filter((r) => allowedIds.has(Number(r.media_id)))
          mergeCandidateMapsInto(segCands, scoreChineseTermHits(termRowsData, queryTerms))
          termRows += termRowsData.length
        }
      }
    }

    const ftsCoreTokens = getCoreTokensOnlyForResidual(residual)
    const inner = buildVisualFtsInnerFromCoreTokens(ftsCoreTokens)
    const wrapped = inner ? wrapFtsQueryForVisualColumnsOnly(inner) : null
    const visualFtsIds = new Set()
    if (wrapped) {
      const rows = searchModel.recallMediaIdsByFts({
        userId,
        ftsQuery: wrapped,
        whereConditions,
        whereParams
      })
      for (const r of rows) {
        const id = Number(r.media_id)
        if (Number.isFinite(id)) visualFtsIds.add(id)
      }
      mergeFtsScores(segCands, rows, containsChinese(residual))
      ftsRows += rows.length
    }
    const lexicalSpec = buildVisualEmbeddingGateLexicalSpec(residual)
    const lexicalTokens = lexicalSpec.tokens
    const actionGroups = extractActionGroups(lexicalSpec.groups)
    const requiredGroupHits = calcRequiredGroupHits(lexicalSpec.groups.length)
    const embeddingQueryText = buildEmbeddingQueryFromCoreTokens(ftsCoreTokens)
    const embeddingRowsRaw = embeddingQueryText
      ? await recallMediaIdsByVisualEmbedding({
          userId,
          queryText: embeddingQueryText,
          whereConditions,
          whereParams
        })
      : []
    const embeddingRows = embeddingRowsRaw.filter((row) => {
      const id = Number(row.media_id)
      if (!Number.isFinite(id)) return false
      if (visualFtsIds.has(id)) return true
      return passLexicalGate(row.description_text, lexicalTokens, {
        minHits: 1,
        synonymGroups: lexicalSpec.groups,
        requiredGroupHits,
        actionGroups
      })
    })
    if (embeddingRows.length > 0) {
      mergeVisualSemanticScores(
        segCands,
        embeddingRows.map((r) => ({ media_id: r.media_id, similarity: r.similarity }))
      )
      semanticRows += embeddingRows.length
    }
  }

  return { termRows, ftsRows, semanticRows }
}

/**
 * 构造中文 term 的长度与权重信息。
 * @param {string} term - 查询词。
 * @returns {{term:string,termLen:number,boost:number}} term 元信息。
 */
function buildChineseQueryTermMeta(term) {
  const termLen = Array.from(term).length
  const boost = termLen >= 2 ? CHINESE_QUERY_TERM_BOOST.multiChar : CHINESE_QUERY_TERM_BOOST.singleChar
  return { term, termLen, boost }
}

/**
 * 中文 term 元信息排序：长度降序，同长度按中文字典序升序。
 * @param {{term:string,termLen:number}} a - 元信息 A。
 * @param {{term:string,termLen:number}} b - 元信息 B。
 * @returns {number} 排序比较值。
 */
function compareChineseQueryTermMeta(a, b) {
  return b.termLen - a.termLen || a.term.localeCompare(b.term, 'zh-Hans-CN')
}

module.exports = {
  applyVisualRecallForSegment
}
