/*
 * @Description: 聚类重建前后的名称/封面恢复与旧资源路径收集（face_clusters、face_cluster_representatives）
 */
/**
 * 人脸聚类迁移辅助：旧缩略图路径、cluster 名称与封面映射、批量恢复名称与封面状态。
 */
const { db } = require('../../db')
const logger = require('../../utils/logger')
const { clearManualCoverRepresentative } = require('./faceClusterRepresentative')

/**
 * 重新聚类前收集用户所有人脸缩略图存储键（去重、非空）
 * @param {number} userId 用户 ID
 * @returns {string[]} 缩略图 storage key 列表
 */
function getOldThumbnailPathsByUserId(userId) {
  const sql = `
    SELECT DISTINCT fe.face_thumbnail_storage_key
    FROM media_face_embeddings fe
    INNER JOIN media m ON fe.media_id = m.id
    WHERE m.user_id = ? 
      AND fe.face_thumbnail_storage_key IS NOT NULL
      AND fe.face_thumbnail_storage_key != ''
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId);
  return rows.map((row) => row.face_thumbnail_storage_key).filter((key) => key);
}

/**
 * 构建旧聚类名称映射（仅自动聚类、有名），用于重建后按人脸重叠恢复名称
 * @param {number} userId 用户 ID
 * @returns {Map<number, { name: string, faceEmbeddingIds: Set<number> }>} cluster_id -> 名称与人脸 id 集合
 */
function getOldClusterNameMapping(userId) {
  // 只获取自动聚类（is_user_assigned = false 或 NULL）的名称
  // 手动聚类（is_user_assigned = true）的记录不会被删除，所以不需要恢复名称
  const sql = `
    SELECT 
      cluster_id,
      name,
      face_embedding_id
    FROM face_clusters
    WHERE user_id = ? 
      AND name IS NOT NULL 
      AND name != ''
      AND (is_user_assigned IS NULL OR is_user_assigned = FALSE)
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId);

  // 构建映射：cluster_id -> {name, faceEmbeddingIds}
  const mapping = new Map();
  for (const row of rows) {
    if (!mapping.has(row.cluster_id)) {
      mapping.set(row.cluster_id, {
        name: row.name,
        faceEmbeddingIds: new Set(),
      });
    }
    mapping.get(row.cluster_id).faceEmbeddingIds.add(row.face_embedding_id);
  }

  return mapping;
}

/**
 * 获取旧的封面设置映射（重新聚类前调用，用于保留用户手动设置的封面）
 * 注意：只获取自动聚类的封面设置（is_user_assigned = false），因为手动聚类的记录不会被删除，不需要恢复封面
 * @param {number|string} userId - 用户ID
 * @returns {Map<number, number>} 映射：face_embedding_id -> old_cluster_id（只包含 representative_type = 2 的记录）
 */
function getOldCoverMapping(userId) {
  // 只获取自动聚类（is_user_assigned = false 或 NULL）且手动设置的封面（representative_type = 2）
  // 手动聚类（is_user_assigned = true）的记录不会被删除，所以不需要恢复封面
  const sql = `
    SELECT 
      cluster_id,
      face_embedding_id
    FROM face_clusters
    WHERE user_id = ? 
      AND representative_type = 2
      AND (is_user_assigned IS NULL OR is_user_assigned = FALSE)
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId);

  // 构建映射：face_embedding_id -> old_cluster_id
  const mapping = new Map();
  for (const row of rows) {
    mapping.set(row.face_embedding_id, row.cluster_id);
  }

  return mapping;
}

/**
 * 恢复聚类名称（根据新旧聚类的 face_embedding_id 重叠度匹配）
 * 使用双向重叠度检查和一对一匹配策略，确保每个名称只分配给一个最匹配的新聚类
 * @param {number|string} userId - 用户ID
 * @param {Map<number, {name: string, faceEmbeddingIds: Set<number>}>} oldClusterMapping - 旧聚类映射
 * @param {Array<{clusterId: number, faceEmbeddingId: number}>} newClusterData - 新聚类数据
 * @param {number} overlapThreshold - 重叠度阈值（0-1），默认 0.6（60%），要求双向重叠度都达到阈值
 * @returns {number} 恢复的名称数量
 */
function restoreClusterNames(userId, oldClusterMapping, newClusterData, overlapThreshold = 0.6) {
  if (!oldClusterMapping || oldClusterMapping.size === 0) {
    return 0;
  }

  // 构建新聚类的 face_embedding_id 集合映射
  const newClusterFaces = new Map(); // cluster_id -> Set<face_embedding_id>
  for (const item of newClusterData) {
    if (!newClusterFaces.has(item.clusterId)) {
      newClusterFaces.set(item.clusterId, new Set());
    }
    newClusterFaces.get(item.clusterId).add(item.faceEmbeddingId);
  }

  // 计算所有新旧聚类的匹配分数矩阵
  // 格式：{ newClusterId: { oldClusterId: { overlapOld, overlapNew, intersection } } }
  const matchMatrix = new Map();

  for (const [newClusterId, newFaceIds] of newClusterFaces.entries()) {
    matchMatrix.set(newClusterId, new Map());
    for (const [oldClusterId, oldClusterInfo] of oldClusterMapping.entries()) {
      const oldFaceIds = oldClusterInfo.faceEmbeddingIds;
      const intersection = new Set([...newFaceIds].filter((id) => oldFaceIds.has(id)));

      // 双向重叠度：既要求新聚类包含足够多的旧聚类人脸，也要求旧聚类的大部分人脸在新聚类中
      const overlapOld = intersection.size / oldFaceIds.size; // 交集 / 旧聚类大小
      const overlapNew = intersection.size / newFaceIds.size; // 交集 / 新聚类大小

      // 只有当双向重叠度都达到阈值时，才认为是匹配的
      if (overlapOld >= overlapThreshold && overlapNew >= overlapThreshold) {
        matchMatrix.get(newClusterId).set(oldClusterId, {
          overlapOld,
          overlapNew,
          intersectionSize: intersection.size,
          name: oldClusterInfo.name,
        });
      }
    }
  }

  // 使用贪心算法进行一对一匹配：优先匹配重叠度最高的对
  // 1. 收集所有可能的匹配对及其分数
  const candidates = [];
  for (const [newClusterId, oldMatches] of matchMatrix.entries()) {
    for (const [oldClusterId, matchInfo] of oldMatches.entries()) {
      // 使用综合分数（交并比 IoU）：交集 / 并集
      const union = newClusterFaces.get(newClusterId).size + oldClusterMapping.get(oldClusterId).faceEmbeddingIds.size - matchInfo.intersectionSize;
      const iou = matchInfo.intersectionSize / union;

      candidates.push({
        newClusterId,
        oldClusterId,
        name: matchInfo.name,
        iou, // 交并比，更公平的匹配指标
        overlapOld: matchInfo.overlapOld,
        overlapNew: matchInfo.overlapNew,
      });
    }
  }

  // 2. 按 IoU 降序排序
  candidates.sort((a, b) => b.iou - a.iou);

  // 3. 贪心匹配：每个旧聚类和新聚类都只能匹配一次
  const matchedOldClusters = new Set();
  const matchedNewClusters = new Set();
  const matches = [];

  for (const candidate of candidates) {
    if (!matchedOldClusters.has(candidate.oldClusterId) && !matchedNewClusters.has(candidate.newClusterId)) {
      matchedOldClusters.add(candidate.oldClusterId);
      matchedNewClusters.add(candidate.newClusterId);
      matches.push(candidate);
    }
  }

  // 4. 应用匹配结果
  let restoredCount = 0;
  const updateNameStmt = db.prepare(`
    UPDATE face_clusters
    SET name = ?, updated_at = ?
    WHERE user_id = ? AND cluster_id = ?
  `);

  for (const match of matches) {
    try {
      const now = Date.now();
      updateNameStmt.run(match.name, now, userId, match.newClusterId);
      restoredCount++;
      logger.info({
        message: `恢复聚类名称: 旧 cluster_id=${match.oldClusterId} -> 新 cluster_id=${match.newClusterId}, 名称="${match.name}", IoU=${(match.iou * 100).toFixed(1)}%, 重叠度(旧)=${(match.overlapOld * 100).toFixed(1)}%, 重叠度(新)=${(match.overlapNew * 100).toFixed(1)}%`,
        details: {
          userId,
          oldClusterId: match.oldClusterId,
          newClusterId: match.newClusterId,
          iou: match.iou,
          overlapOld: match.overlapOld,
          overlapNew: match.overlapNew,
        },
      });
    } catch (error) {
      logger.warn({
        message: `恢复聚类名称失败: cluster_id=${match.newClusterId}`,
        details: { userId, error: error.message },
      });
    }
  }

  return restoredCount;
}

/**
 * 恢复封面设置（根据 face_embedding_id 找到新的 cluster_id 并设置）
 * @param {number|string} userId - 用户ID
 * @param {Map<number, number>} oldCoverMapping - 旧封面映射：face_embedding_id -> old_cluster_id
 * @param {Array<{clusterId: number, faceEmbeddingId: number}>} newClusterData - 新聚类数据
 * @returns {number} 恢复的封面数量
 */
function restoreCoverSettings(userId, oldCoverMapping, newClusterData) {
  if (!oldCoverMapping || oldCoverMapping.size === 0) {
    return 0;
  }

  // 构建新聚类的映射：face_embedding_id -> new_cluster_id
  const newClusterFaces = new Map(); // face_embedding_id -> cluster_id
  for (const item of newClusterData) {
    // 如果同一个 face_embedding_id 出现在多个 cluster 中，取第一个（理论上不应该发生）
    if (!newClusterFaces.has(item.faceEmbeddingId)) {
      newClusterFaces.set(item.faceEmbeddingId, item.clusterId);
    }
  }

  // 恢复封面设置
  let restoredCount = 0;
  const updateCoverStmt = db.prepare(`
    UPDATE face_clusters
    SET representative_type = 2
    WHERE user_id = ? AND cluster_id = ? AND face_embedding_id = ?
  `);

  for (const [faceEmbeddingId, oldClusterId] of oldCoverMapping.entries()) {
    const newClusterId = newClusterFaces.get(faceEmbeddingId);
    if (newClusterId !== undefined) {
      try {
        // 先清除该新 cluster 中其他手动设置的封面（如果有）
        clearManualCoverRepresentative(userId, newClusterId);

        // 设置新的手动封面
        const result = updateCoverStmt.run(userId, newClusterId, faceEmbeddingId);
        if (result.changes > 0) {
          restoredCount++;
          logger.info({
            message: `恢复封面设置: face_embedding_id=${faceEmbeddingId}, 旧 cluster_id=${oldClusterId} -> 新 cluster_id=${newClusterId}`,
            details: { userId, faceEmbeddingId, oldClusterId, newClusterId },
          });
        }
      } catch (error) {
        logger.warn({
          message: `恢复封面设置失败: face_embedding_id=${faceEmbeddingId}`,
          details: { userId, faceEmbeddingId, oldClusterId, newClusterId, error: error.message },
        });
      }
    } else {
      // face_embedding_id 在新聚类中不存在（可能被排除或删除）
      logger.warn({
        message: `无法恢复封面设置: face_embedding_id=${faceEmbeddingId} 在新聚类中不存在`,
        details: { userId, faceEmbeddingId, oldClusterId },
      });
    }
  }

  return restoredCount;
}

module.exports = {
  getOldThumbnailPathsByUserId,
  getOldClusterNameMapping,
  getOldCoverMapping,
  restoreClusterNames,
  restoreCoverSettings
}
