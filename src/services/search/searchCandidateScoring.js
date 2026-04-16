/**
 * 搜索候选评分层：负责候选对象生命周期、分值累积、候选合并与最终排序。
 */
const { FTS_RANKING, SEARCH_TERM_FIELD_WEIGHTS } = require('../../config/searchRankingWeights')

const VISUAL_EMBEDDING_SCORE_SCALE = 120

/**
 * 获取或创建候选对象。
 * @param {Map<number, any>} candidates 候选集合
 * @param {number} mediaId 媒体 ID
 * @returns {any} 候选对象
 */
function ensureCandidate(candidates, mediaId) {
  if (!candidates.has(mediaId)) {
    candidates.set(mediaId, {
      mediaId,
      score: 0,
      chineseHits: 0,
      ftsRank: null,
      hasOcrMatch: false,
      hasVisualMatch: false,
      visualSemanticScore: 0,
      matchedFields: new Set(),
      matchedTermsByField: new Map(),
      roleSignals: {
        subject: false,
        action: false,
        scene: false
      }
    })
  }
  return candidates.get(mediaId)
}

/**
 * 对中文 terms 精确命中结果进行打分并返回候选集。
 * @param {{media_id:number, field_type:string, term:string}[]} termRows terms 命中行
 * @param {{term:string, termLen:number, boost:number}[]} queryTerms 查询 terms 信息
 * @returns {Map<number, any>} 新候选集合
 */
function scoreChineseTermHits(termRows, queryTerms) {
  const candidates = new Map()
  const boostByTerm = new Map(queryTerms.map((item) => [item.term, item]))

  for (const row of termRows || []) {
    const mediaId = Number(row.media_id)
    if (!Number.isFinite(mediaId)) continue
    const queryTerm = boostByTerm.get(row.term)
    if (!queryTerm) continue

    const candidate = ensureCandidate(candidates, mediaId)
    const fieldWeight = SEARCH_TERM_FIELD_WEIGHTS[row.field_type] || 40
    candidate.score += fieldWeight + queryTerm.boost
    candidate.chineseHits += 1
    candidate.hasVisualMatch = true
    candidate.matchedFields.add(row.field_type)
    if (!candidate.matchedTermsByField.has(row.field_type)) {
      candidate.matchedTermsByField.set(row.field_type, new Set())
    }
    candidate.matchedTermsByField.get(row.field_type).add(row.term)
  }

  return candidates
}

/**
 * 将 FTS 召回结果按顺位分数并入候选集。
 * @param {Map<number, any>} candidates 候选集合
 * @param {{media_id:number}[]} ftsRows FTS 召回行
 * @param {boolean} hasChineseQuery 是否中文查询
 * @returns {void}
 */
function mergeFtsScores(candidates, ftsRows, hasChineseQuery) {
  const baseScore = hasChineseQuery ? FTS_RANKING.chineseBaseScore : FTS_RANKING.nonChineseBaseScore
  for (let index = 0; index < (ftsRows || []).length; index += 1) {
    const row = ftsRows[index]
    const mediaId = Number(row.media_id)
    if (!Number.isFinite(mediaId)) continue
    const candidate = ensureCandidate(candidates, mediaId)
    candidate.score += Math.max(FTS_RANKING.minScore, baseScore - index)
    candidate.ftsRank = index + 1
    candidate.hasVisualMatch = true
  }
}

/**
 * 将向量召回相似度并入候选集。
 * @param {Map<number, any>} candidates 候选集合
 * @param {{media_id:number, similarity:number}[]} embeddingRows 向量召回行
 * @returns {void}
 */
function mergeVisualSemanticScores(candidates, embeddingRows) {
  for (const row of embeddingRows || []) {
    const mediaId = Number(row.media_id)
    if (!Number.isFinite(mediaId)) continue
    const similarity = Number(row.similarity)
    if (!Number.isFinite(similarity)) continue
    const candidate = ensureCandidate(candidates, mediaId)
    candidate.visualSemanticScore = Math.max(candidate.visualSemanticScore || 0, similarity)
    candidate.score += similarity * VISUAL_EMBEDDING_SCORE_SCALE
    candidate.hasVisualMatch = true
  }
}

/**
 * 对 OCR LIKE 命中结果打分。
 * @param {Map<number, any>} candidates 候选集合
 * @param {{media_id:number}[]} ocrRows OCR 命中行
 * @returns {void}
 */
function scoreOcrTextLikeHits(candidates, ocrRows) {
  for (const row of ocrRows || []) {
    const mediaId = Number(row.media_id)
    if (!Number.isFinite(mediaId)) continue
    const candidate = ensureCandidate(candidates, mediaId)
    candidate.hasOcrMatch = true
    candidate.score += SEARCH_TERM_FIELD_WEIGHTS.ocrLikeHit
  }
}

/**
 * 计算候选分层：双命中 > OCR > 视觉 > 其它。
 * @param {any} candidate 候选对象
 * @returns {number} 分层等级
 */
function candidateRankTier(candidate) {
  if (candidate.hasOcrMatch && candidate.hasVisualMatch) return 3
  if (candidate.hasOcrMatch) return 2
  if (candidate.hasVisualMatch) return 1
  return 0
}

/**
 * 对候选集合进行最终排序。
 * @param {Map<number, any>} candidates 候选集合
 * @param {Map<number, any>} mediaMap 媒体详情映射
 * @returns {any[]} 已排序候选数组
 */
function sortCandidates(candidates, mediaMap) {
  return Array.from(candidates.values()).sort((a, b) => {
    const tierA = candidateRankTier(a)
    const tierB = candidateRankTier(b)
    if (tierB !== tierA) {
      return tierB - tierA
    }
    if (b.score !== a.score) {
      return b.score - a.score
    }
    const mediaA = mediaMap.get(a.mediaId)
    const mediaB = mediaMap.get(b.mediaId)
    const capturedA = Number(mediaA?.capturedAt || 0)
    const capturedB = Number(mediaB?.capturedAt || 0)
    if (capturedB !== capturedA) {
      return capturedB - capturedA
    }
    return b.mediaId - a.mediaId
  })
}

/**
 * 深拷贝候选对象（包含 Set/Map 字段）。
 * @param {any} candidate 原候选对象
 * @returns {any} 新候选对象
 */
function cloneCandidate(candidate) {
  const matchedTermsByField = new Map()
  candidate.matchedTermsByField.forEach((set, key) => {
    matchedTermsByField.set(key, new Set(set))
  })
  return {
    mediaId: candidate.mediaId,
    score: candidate.score,
    chineseHits: candidate.chineseHits,
    ftsRank: candidate.ftsRank,
    hasOcrMatch: candidate.hasOcrMatch,
    hasVisualMatch: Boolean(candidate.hasVisualMatch),
    matchedFields: new Set(candidate.matchedFields),
    matchedTermsByField,
    roleSignals: { ...candidate.roleSignals },
    visualSemanticScore: candidate.visualSemanticScore || 0
  }
}

/**
 * 将 source 候选分值与命中信息合并到 target。
 * @param {any} target 目标候选
 * @param {any} source 来源候选
 * @returns {void}
 */
function mergeCandidateInto(target, source) {
  target.score += source.score
  target.hasOcrMatch = target.hasOcrMatch || source.hasOcrMatch
  target.hasVisualMatch = Boolean((target.hasVisualMatch ?? false) || (source.hasVisualMatch ?? false))
  target.chineseHits += source.chineseHits
  for (const field of source.matchedFields) target.matchedFields.add(field)
  source.matchedTermsByField.forEach((set, key) => {
    if (!target.matchedTermsByField.has(key)) target.matchedTermsByField.set(key, new Set())
    set.forEach((term) => target.matchedTermsByField.get(key).add(term))
  })
  target.roleSignals.subject = target.roleSignals.subject || source.roleSignals.subject
  target.roleSignals.action = target.roleSignals.action || source.roleSignals.action
  target.roleSignals.scene = target.roleSignals.scene || source.roleSignals.scene
  target.visualSemanticScore = Math.max(target.visualSemanticScore || 0, source.visualSemanticScore || 0)
}

/**
 * 将分段候选集合并到全局候选集。
 * @param {Map<number, any>} globalCandidates 全局候选集合
 * @param {Map<number, any>} segmentCandidates 分段候选集合
 * @returns {void}
 */
function mergeCandidateMapsInto(globalCandidates, segmentCandidates) {
  for (const [mediaId, candidate] of segmentCandidates) {
    const id = Number(mediaId)
    if (!Number.isFinite(id)) continue
    if (!globalCandidates.has(id)) {
      globalCandidates.set(id, cloneCandidate(candidate))
    } else {
      mergeCandidateInto(globalCandidates.get(id), candidate)
    }
  }
}

module.exports = {
  scoreChineseTermHits,
  mergeFtsScores,
  mergeVisualSemanticScores,
  scoreOcrTextLikeHits,
  sortCandidates,
  mergeCandidateMapsInto
}
