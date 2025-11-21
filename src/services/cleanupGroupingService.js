const { CLEANUP_TYPES } = require("../constants/cleanupTypes");
const cleanupModel = require("../models/cleanupModel");
const logger = require("../utils/logger");

const DEFAULT_SIMILAR_HAMMING_THRESHOLD = Number(process.env.CLEANUP_SIMILAR_HAMMING_THRESHOLD || 8);

function rebuildCleanupGroups({ userId }) {
  if (!userId) {
    throw new Error("userId is required to rebuild cleanup groups");
  }

  const images = cleanupModel.selectCleanupCandidatesByUser(userId);
  if (!images || images.length === 0) {
    cleanupModel.deleteGroupsByType(userId, CLEANUP_TYPES.DUPLICATE);
    cleanupModel.deleteGroupsByType(userId, CLEANUP_TYPES.SIMILAR);
    cleanupModel.deleteGroupsByType(userId, CLEANUP_TYPES.BLURRY);
    return {
      duplicateGroupCount: 0,
      similarGroupCount: 0,
      blurryGroupCount: 0,
    };
  }

  const duplicateGroups = _buildDuplicateGroups(images);
  const duplicateSummary = _replaceGroups({
    userId,
    groupType: CLEANUP_TYPES.DUPLICATE,
    groups: duplicateGroups,
  });

  const similarGroups = _buildSimilarGroups(images, duplicateGroups);
  const similarSummary = _replaceGroups({
    userId,
    groupType: CLEANUP_TYPES.SIMILAR,
    groups: similarGroups,
  });

  // 模糊图：创建一个包含所有模糊图的分组
  const blurryGroups = _buildBlurryGroups(images);
  const blurrySummary = _replaceGroups({
    userId,
    groupType: CLEANUP_TYPES.BLURRY,
    groups: blurryGroups,
  });

  return {
    duplicateGroupCount: duplicateSummary.groupCount,
    similarGroupCount: similarSummary.groupCount,
    blurryGroupCount: blurrySummary.groupCount,
  };
}

function _replaceGroups({ userId, groupType, groups }) {
  cleanupModel.deleteGroupsByType(userId, groupType);

  if (!groups || groups.length === 0) {
    return { groupCount: 0 };
  }

  let createdGroups = 0;
  for (const group of groups) {
    try {
      const groupId = cleanupModel.insertCleanupGroup({
        userId,
        groupType,
        primaryImageId: group.primaryImageId,
        score: group.score,
        memberCount: group.members.length,
        totalSizeBytes: group.totalSizeBytes,
      });

      createdGroups += 1;

      for (const member of group.members) {
        cleanupModel.insertCleanupGroupMember(groupId, member);
      }
    } catch (error) {
      logger.error({
        message: `插入清理分组失败: ${groupType}`,
        details: { userId, error: error.message },
      });
    }
  }

  return {
    groupCount: createdGroups,
  };
}

/**
 * 构建重复图片分组
 * 使用 image_hash（文件 SHA256 哈希）判断重复图
 * 如果两个文件的 image_hash 相同，说明是完全相同的文件（重复上传）
 */
function _buildDuplicateGroups(images) {
  const groupsByHash = new Map();
  for (const image of images) {
    const fileHash = image.image_hash;

    // 必须有 image_hash 才能判断重复
    if (!fileHash || typeof fileHash !== "string") continue;

    const normalizedHash = fileHash.trim().toLowerCase();
    if (!groupsByHash.has(normalizedHash)) {
      groupsByHash.set(normalizedHash, []);
    }
    groupsByHash.get(normalizedHash).push(image);
  }

  const result = [];
  for (const members of groupsByHash.values()) {
    if (!members || members.length < 2) continue;
    const group = _createGroupFromMembers(members, { similarityResolver: () => 1 });
    result.push(group);
  }
  return result;
}

/**
 * 构建相似图片分组（优化版：使用倒排索引）
 * 优化策略：按哈希前缀分组，只比较同组或相邻组的图片，大幅减少比较次数
 * 时间复杂度：从 O(n²) 优化到 O(n × k)，k 为平均组大小（通常远小于 n）
 */
function _buildSimilarGroups(images, duplicateGroups) {
  const duplicateIds = new Set();
  duplicateGroups.forEach((group) => {
    group.members.forEach((member) => duplicateIds.add(member.imageId));
  });

  const candidates = images
    .filter((image) => {
      if (duplicateIds.has(image.id)) return false;
      if (!image.image_phash || typeof image.image_phash !== "string") return false;
      return image.image_phash.trim().length >= 8;
    })
    .map((image) => ({
      ...image,
      normalizedHash: image.image_phash.trim().toLowerCase(),
    }));

  if (candidates.length < 2) {
    return [];
  }

  const threshold = DEFAULT_SIMILAR_HAMMING_THRESHOLD;
  const used = new Set();
  const groups = [];

  // ========== 优化：倒排索引 - 按哈希前缀分组 ==========
  // 使用前 8 个字符（4 个字节）作为桶的键，这样可以快速定位可能相似的图片
  // 如果阈值是 8，那么最多 8 位不同，前 8 位至少会有一些相同或相近
  const PREFIX_LENGTH = 8; // 使用前 8 个字符（4 个字节）作为前缀
  const buckets = new Map();

  candidates.forEach((image) => {
    const prefix = image.normalizedHash.substring(0, PREFIX_LENGTH);
    if (!buckets.has(prefix)) {
      buckets.set(prefix, []);
    }
    buckets.get(prefix).push(image);
  });

  // ========== 优化：只比较同组或相邻组的图片 ==========
  // 对于每个候选图片，只检查：
  // 1. 同组内的其他图片
  // 2. 前缀相近的组（汉明距离在阈值内的前缀）
  const bucketKeys = Array.from(buckets.keys());
  let comparisonCount = 0; // 性能统计：比较次数
  let skippedByPrefix = 0; // 性能统计：通过前缀剪枝跳过的组数

  for (let i = 0; i < bucketKeys.length; i += 1) {
    const bucketKey = bucketKeys[i];
    const bucketImages = buckets.get(bucketKey);

    // 处理当前桶内的图片
    for (let j = 0; j < bucketImages.length; j += 1) {
      const seed = bucketImages[j];
      if (used.has(seed.id)) continue;

      const members = [seed];
      used.add(seed.id);

      // 1. 比较同组内的其他图片
      for (let k = j + 1; k < bucketImages.length; k += 1) {
        const candidate = bucketImages[k];
        if (used.has(candidate.id)) continue;

        comparisonCount += 1;
        const dist = _hammingDistance(seed.normalizedHash, candidate.normalizedHash);
        if (dist <= threshold) {
          members.push(candidate);
          used.add(candidate.id);
        }
      }

      // 2. 比较相邻组的图片（前缀相近的组）
      // 只检查前缀汉明距离 <= threshold 的组
      for (let k = i + 1; k < bucketKeys.length; k += 1) {
        const otherBucketKey = bucketKeys[k];
        const prefixDist = _hammingDistance(bucketKey, otherBucketKey);

        // 如果前缀距离已经超过阈值，那么整个哈希的距离肯定也超过阈值
        // 可以跳过这个组（优化：提前剪枝）
        if (prefixDist > threshold) {
          skippedByPrefix += 1;
          continue;
        }

        const otherBucketImages = buckets.get(otherBucketKey);
        for (const candidate of otherBucketImages) {
          if (used.has(candidate.id)) continue;

          comparisonCount += 1;
          const dist = _hammingDistance(seed.normalizedHash, candidate.normalizedHash);
          if (dist <= threshold) {
            members.push(candidate);
            used.add(candidate.id);
          }
        }
      }

      if (members.length > 1) {
        const group = _createGroupFromMembers(members, {
          similarityResolver: (primary, member) => {
            const dist = _hammingDistance(primary.normalizedHash, member.normalizedHash);
            return Number((1 - dist / 64).toFixed(4));
          },
        });
        groups.push(group);
      }
    }
  }

  // 性能统计日志（仅在开发环境或需要调试时输出）
  if (process.env.NODE_ENV === "development" || process.env.LOG_CLEANUP_PERFORMANCE === "true") {
    const naiveComparisons = (candidates.length * (candidates.length - 1)) / 2;
    const improvement = naiveComparisons > 0 ? ((1 - comparisonCount / naiveComparisons) * 100).toFixed(1) : 0;
    logger.info({
      message: "相似图分组性能统计",
      details: {
        candidateCount: candidates.length,
        bucketCount: buckets.size,
        comparisonCount,
        naiveComparisons,
        improvementPercent: `${improvement}%`,
        skippedByPrefix,
      },
    });
  }

  return groups;
}

/**
 * 构建模糊图片分组
 * 所有模糊图放在一个分组中，按清晰度分数（sharpness_score）升序排序（最模糊的在前）
 */
function _buildBlurryGroups(images) {
  // 使用清晰度分数和阈值判断模糊图
  // 阈值配置：在 .env 文件中设置 BLURRY_SHARPNESS_THRESHOLD
  const blurryThreshold = Number(process.env.BLURRY_SHARPNESS_THRESHOLD || 0.25);

  // 过滤出模糊图：sharpness_score < 阈值
  const blurryImages = images.filter((img) => {
    if (img.sharpness_score === null || img.sharpness_score === undefined) {
      return false; // 未分析的图片不参与模糊图分组
    }
    return img.sharpness_score < blurryThreshold;
  });

  if (blurryImages.length === 0) {
    return [];
  }

  // 按清晰度分数升序排序（清晰度分数越低，越模糊，最模糊的排在前面）
  // 如果清晰度分数相同，按 aesthetic_score 降序排序
  const sorted = [...blurryImages].sort((a, b) => {
    const aSharpness = a.sharpness_score ?? 0;
    const bSharpness = b.sharpness_score ?? 0;
    if (aSharpness !== bSharpness) return aSharpness - bSharpness;

    // 清晰度分数相同，按 aesthetic_score 降序排序
    const aAesthetic = a.aesthetic_score ?? 0;
    const bAesthetic = b.aesthetic_score ?? 0;
    if (aAesthetic !== bAesthetic) return bAesthetic - aAesthetic;

    // 都相同，按创建时间排序
    return (b.image_created_at ?? 0) - (a.image_created_at ?? 0);
  });

  // 创建单个分组，包含所有模糊图
  const primary = sorted[0];
  const members = sorted.map((image) => ({
    imageId: image.id,
    rankScore: _computeRankScore(image),
    similarity: 1.0, // 模糊图之间没有相似度概念，统一设为 1.0
    aestheticScore: image.aesthetic_score ?? null,
  }));

  const totalSizeBytes = sorted.reduce((acc, img) => acc + (img.file_size_bytes || 0), 0);

  return [
    {
      primaryImageId: primary.id,
      totalSizeBytes,
      members,
    },
  ];
}

function _createGroupFromMembers(members, { similarityResolver }) {
  const sorted = [...members].sort((a, b) => {
    const aRank = _computeRankScore(a);
    const bRank = _computeRankScore(b);
    if (aRank !== bRank) return bRank - aRank;
    return (b.image_created_at ?? 0) - (a.image_created_at ?? 0);
  });

  const primary = sorted[0];
  const groupMembers = sorted.map((image) => {
    const similarity = similarityResolver(primary, image);
    return {
      imageId: image.id,
      rankScore: _computeRankScore(image),
      similarity,
      aestheticScore: image.aesthetic_score ?? null,
    };
  });

  const totalSizeBytes = sorted.reduce((acc, item) => acc + (item.file_size_bytes || 0), 0);

  return {
    primaryImageId: primary.id,
    totalSizeBytes,
    members: groupMembers,
  };
}

function _computeRankScore(image) {
  const aesthetic = typeof image.aesthetic_score === "number" ? image.aesthetic_score : 0;
  const faceQuality = typeof image.primary_face_quality === "number" ? image.primary_face_quality : 0;
  // 移除 sharpness_score 权重，仅使用 aesthetic_score 和 faceQuality
  return Number((0.8 * aesthetic + 0.2 * faceQuality).toFixed(6));
}

function _hammingDistance(hashA, hashB) {
  if (!hashA || !hashB) return 64;
  try {
    let xor = BigInt(`0x${hashA}`) ^ BigInt(`0x${hashB}`);
    let count = 0;
    while (xor > 0n) {
      count += Number(xor & 1n);
      xor >>= 1n;
    }
    return count;
  } catch (error) {
    logger.warn({
      message: "计算哈希距离失败，返回最大距离",
      details: { error: error.message },
    });
    return 64;
  }
}

module.exports = {
  rebuildCleanupGroups,
};
