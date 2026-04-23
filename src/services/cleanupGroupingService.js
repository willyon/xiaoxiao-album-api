const cleanupModel = require('../models/cleanupModel')
const mediaModel = require('../models/mediaModel')
const logger = require('../utils/logger')

const DEFAULT_SIMILAR_HAMMING_THRESHOLD = Number(process.env.CLEANUP_SIMILAR_HAMMING_THRESHOLD || 8)
const BLURRY_SHARPNESS_THRESHOLD = Number(process.env.BLURRY_SHARPNESS_THRESHOLD || 0.25)

/**
 * 重建用户清理分组（相似图 + 模糊图标记）。
 * @param {{userId:number|string}} params - 重建参数。
 * @returns {{similarGroupCount:number}} 重建摘要。
 */
function rebuildCleanupGroups({ userId }) {
  if (!userId) {
    throw new Error('userId is required to rebuild cleanup groups')
  }

  const images = cleanupModel.selectCleanupCandidatesByUser(userId)
  if (!images || images.length === 0) {
    cleanupModel.deleteGroupsByUser(userId)
    mediaModel.updateBlurryForUser(userId, [])
    return {
      similarGroupCount: 0
    }
  }

  const similarGroups = _buildSimilarGroups(images)
  const similarSummary = _replaceGroups({
    userId,
    groups: similarGroups
  })

  // 模糊图：只更新 images.is_blurry，不再写入 similar_groups
  const blurryMediaIds = images.filter((img) => img.sharpness_score != null && img.sharpness_score < BLURRY_SHARPNESS_THRESHOLD).map((img) => img.id)
  mediaModel.updateBlurryForUser(userId, blurryMediaIds)

  return {
    similarGroupCount: similarSummary.groupCount
  }
}

/**
 * 用新分组替换用户旧分组。
 * @param {{userId:number|string,groups:Array<object>}} params - 替换参数。
 * @returns {{groupCount:number}} 创建分组数量。
 */
function _replaceGroups({ userId, groups }) {
  try {
    return cleanupModel.replaceGroupsByUser({ userId, groups })
  } catch (error) {
    logger.error({
      message: '替换清理分组失败: similar',
      details: { userId, error: error.message }
    })
    throw error
  }
}

/**
 * 构建相似图片分组（优化版：使用倒排索引）
 * 优化策略：按哈希前缀分组，只比较同组或相邻组的图片，大幅减少比较次数
 * 时间复杂度：从 O(n²) 优化到 O(n × k)，k 为平均组大小（通常远小于 n）
 * @param {Array<object>} images - 候选图片列表。
 * @returns {Array<{members:Array<object>}>} 相似图分组结果。
 */
function _buildSimilarGroups(images) {
  const candidates = images
    .filter((image) => {
      if (!image.image_phash || typeof image.image_phash !== 'string') return false
      return image.image_phash.trim().length >= 8
    })
    .map((image) => ({
      ...image,
      normalizedHash: image.image_phash.trim().toLowerCase()
    }))

  if (candidates.length < 2) {
    return []
  }

  const threshold = DEFAULT_SIMILAR_HAMMING_THRESHOLD
  const used = new Set()
  const groups = []

  // ========== 优化：倒排索引 - 按哈希前缀分组 ==========
  // 使用前 8 个字符（4 个字节）作为桶的键，这样可以快速定位可能相似的图片
  // 如果阈值是 8，那么最多 8 位不同，前 8 位至少会有一些相同或相近
  const PREFIX_LENGTH = 8 // 使用前 8 个字符（4 个字节）作为前缀
  const buckets = new Map()

  candidates.forEach((image) => {
    const prefix = image.normalizedHash.substring(0, PREFIX_LENGTH)
    if (!buckets.has(prefix)) {
      buckets.set(prefix, [])
    }
    buckets.get(prefix).push(image)
  })

  // ========== 优化：只比较同组或相邻组的图片 ==========
  // 对于每个候选图片，只检查：
  // 1. 同组内的其他图片
  // 2. 前缀相近的组（汉明距离在阈值内的前缀）
  const bucketKeys = Array.from(buckets.keys())
  let comparisonCount = 0 // 性能统计：比较次数
  let skippedByPrefix = 0 // 性能统计：通过前缀剪枝跳过的组数

  for (let i = 0; i < bucketKeys.length; i += 1) {
    const bucketKey = bucketKeys[i]
    const bucketImages = buckets.get(bucketKey)

    // 处理当前桶内的图片
    for (let j = 0; j < bucketImages.length; j += 1) {
      const seed = bucketImages[j]
      if (used.has(seed.id)) continue

      const members = [seed]
      used.add(seed.id)

      // 1. 比较同组内的其他图片
      for (let k = j + 1; k < bucketImages.length; k += 1) {
        const candidate = bucketImages[k]
        if (used.has(candidate.id)) continue

        comparisonCount += 1
        const dist = _hammingDistance(seed.normalizedHash, candidate.normalizedHash)
        if (dist <= threshold) {
          members.push(candidate)
          used.add(candidate.id)
        }
      }

      // 2. 比较相邻组的图片（前缀相近的组）
      // 只检查前缀汉明距离 <= threshold 的组
      for (let k = i + 1; k < bucketKeys.length; k += 1) {
        const otherBucketKey = bucketKeys[k]
        const prefixDist = _hammingDistance(bucketKey, otherBucketKey)

        // 如果前缀距离已经超过阈值，那么整个哈希的距离肯定也超过阈值
        // 可以跳过这个组（优化：提前剪枝）
        if (prefixDist > threshold) {
          skippedByPrefix += 1
          continue
        }

        const otherBucketImages = buckets.get(otherBucketKey)
        for (const candidate of otherBucketImages) {
          if (used.has(candidate.id)) continue

          comparisonCount += 1
          const dist = _hammingDistance(seed.normalizedHash, candidate.normalizedHash)
          if (dist <= threshold) {
            members.push(candidate)
            used.add(candidate.id)
          }
        }
      }

      if (members.length > 1) {
        const group = _createGroupFromMembers(members, {
          similarityResolver: (primary, member) => {
            const dist = _hammingDistance(primary.normalizedHash, member.normalizedHash)
            return Number((1 - dist / 64).toFixed(4))
          }
        })
        groups.push(group)
      }
    }
  }

  // 性能统计日志（仅在开发环境或需要调试时输出）
  if (process.env.NODE_ENV === 'development' || process.env.LOG_CLEANUP_PERFORMANCE === 'true') {
    const naiveComparisons = (candidates.length * (candidates.length - 1)) / 2
    const improvement = naiveComparisons > 0 ? ((1 - comparisonCount / naiveComparisons) * 100).toFixed(1) : 0
    logger.info({
      message: '相似图分组性能统计',
      details: {
        candidateCount: candidates.length,
        bucketCount: buckets.size,
        comparisonCount,
        naiveComparisons,
        improvementPercent: `${improvement}%`,
        skippedByPrefix
      }
    })
  }

  return groups
}

/**
 * 由成员列表构建单个分组结构。
 * @param {Array<object>} members - 分组成员。
 * @param {{similarityResolver:(primary:any,member:any)=>number}} options - 计算选项。
 * @returns {{members:Array<object>}} 分组对象。
 */
function _createGroupFromMembers(members, { similarityResolver }) {
  const sorted = [...members].sort((a, b) => _compareCleanupRecommendation(a, b))

  const primary = sorted[0]
  const groupMembers = sorted.map((image) => {
    const similarity = similarityResolver(primary, image)
    return {
      mediaId: image.id,
      rankScore: _encodeCleanupRankScore(image),
      similarity
    }
  })

  return {
    members: groupMembers
  }
}

/** 分层推荐：收藏优先；其余按清晰度 → 分辨率 → 笑脸 → 人脸数 → 人物数，最后时间与 id。 */
function _compareCleanupRecommendation(a, b) {
  const sa = _encodeCleanupRankScore(a)
  const sb = _encodeCleanupRankScore(b)
  if (Math.abs(sb - sa) > 1e-6) return sb - sa
  const ca = Number(a.image_created_at) || 0
  const cb = Number(b.image_created_at) || 0
  if (cb !== ca) return cb - ca
  return (Number(b.id) || 0) - (Number(a.id) || 0)
}

/**
 * 将分层规则压入单一 rank_score，供库内 ORDER BY 与删图后排序一致（任意收藏分高于非收藏分）。
 * @param {object} image - 候选媒体行（含清理查询字段）。
 * @returns {number}
 */
function _encodeCleanupRankScore(image) {
  const fav = _cleanupIsFavorite(image) ? 1 : 0
  const sharpInt = Math.round(_cleanupSharpnessNorm(image) * 1000)
  const areaInt = Math.round(_cleanupAreaNorm(image) * 1000)
  const happy = _cleanupTagsHasHappy(image.expression_tags) ? 1 : 0
  const fc = Math.min(Math.max(Number(image.face_count) || 0, 0), 99)
  const pc = Math.min(Math.max(Number(image.person_count) || 0, 0), 99)
  return fav * 1e13 + sharpInt * 1e9 + areaInt * 1e6 + happy * 1e5 + fc * 1e3 + pc
}

function _cleanupIsFavorite(image) {
  return image.is_favorite === 1 || image.is_favorite === true
}

/** @param {{sharpness_score?:number}} image */
function _cleanupSharpnessNorm(image) {
  const s = Number(image.sharpness_score)
  if (!Number.isFinite(s)) return 0
  return Math.min(Math.max(s, 0), 1)
}

const CLEANUP_AREA_NORM_CAP = 40_000_000

/** @param {{width_px?:number,height_px?:number,hd_width_px?:number,hd_height_px?:number}} image */
function _cleanupAreaNorm(image) {
  const w = Number(image.width_px) || 0
  const h = Number(image.height_px) || 0
  const hdw = Number(image.hd_width_px) || 0
  const hdh = Number(image.hd_height_px) || 0
  const area = Math.max(w * h, hdw * hdh, 0)
  if (area <= 0) return 0
  return Math.min(Math.log1p(area) / Math.log1p(CLEANUP_AREA_NORM_CAP), 1)
}

/** 与封面排序一致：expression_tags 去空白后按逗号包裹匹配 happy。 */
function _cleanupTagsHasHappy(expressionTags) {
  if (expressionTags == null) return false
  const normalized = String(expressionTags).replace(/\s+/g, '')
  return `,${normalized},`.includes(',happy,')
}

/**
 * 计算两个感知哈希的汉明距离。
 * @param {string} hashA - 哈希 A。
 * @param {string} hashB - 哈希 B。
 * @returns {number} 汉明距离。
 */
function _hammingDistance(hashA, hashB) {
  if (!hashA || !hashB) return 64
  try {
    let xor = BigInt(`0x${hashA}`) ^ BigInt(`0x${hashB}`)
    let count = 0
    while (xor > 0n) {
      count += Number(xor & 1n)
      xor >>= 1n
    }
    return count
  } catch (error) {
    logger.warn({
      message: '计算哈希距离失败，返回最大距离',
      details: { error: error.message }
    })
    return 64
  }
}

module.exports = {
  rebuildCleanupGroups
}
