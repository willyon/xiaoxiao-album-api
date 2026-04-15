/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类数据模型 - 处理 face_clusters 表的 CRUD 操作
 *
 * 📋 核心功能:
 * • 批量插入聚类结果
 * • 查询用户的聚类数据
 * • 删除用户的聚类数据（重新聚类时使用）
 * • 获取聚类统计信息
 */

const { db } = require("../services/database");
const logger = require("../utils/logger");

/**
 * 获取用户的所有人脸 embedding 数据（用于聚类）
 * @param {number} userId - 用户ID
 * @returns {Array<Object>} 人脸 embedding 列表，包含 id 和 embedding
 */
function getFaceEmbeddingsByUserId(userId) {
  // 排除已经在手动聚类中的 face_embedding（is_user_assigned = TRUE）
  // 这样可以避免手动聚类的图片在重新聚类时被重复分配到其他聚类中
  const sql = `
    SELECT 
      fe.id,
      fe.embedding,
      fe.media_id AS image_id,
      fe.face_index,
      m.user_id
    FROM media_face_embeddings fe
    INNER JOIN media m ON fe.media_id = m.id
    LEFT JOIN face_clusters fc ON fe.id = fc.face_embedding_id 
      AND fc.user_id = ? 
      AND fc.is_user_assigned = TRUE
    WHERE m.user_id = ? 
      AND m.deleted_at IS NULL
      AND fc.face_embedding_id IS NULL  -- 排除已经在手动聚类中的记录
    ORDER BY fe.id ASC
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, userId);

  // 解析 embedding（从 BLOB 转换为数组）
  return rows.map((row) => ({
    id: row.id,
    imageId: row.image_id,
    faceIndex: row.face_index,
    embedding: JSON.parse(row.embedding.toString()), // BLOB -> Buffer -> String -> Array
    userId: row.user_id,
  }));
}

/**
 * 获取用户的所有旧缩略图路径（重新聚类前用于清理）
 * @param {number} userId - 用户ID
 * @returns {Array<string>} 缩略图存储路径数组
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
 * 删除用户的所有聚类数据（重新聚类前调用）
 * @param {number} userId - 用户ID
 * @param {Object} options - 选项
 * @param {boolean} options.excludeUserAssigned - 是否排除用户手动分配的记录（默认 false）
 * @returns {Object} 返回对象 { affectedRows: 删除的行数 }
 */
function deleteFaceClustersByUserId(userId, options = {}) {
  const { excludeUserAssigned = false } = options;

  let sql = `DELETE FROM face_clusters WHERE user_id = ?`;

  if (excludeUserAssigned) {
    sql += ` AND (is_user_assigned IS NULL OR is_user_assigned = FALSE)`;
  }

  const stmt = db.prepare(sql);
  const result = stmt.run(userId);

  return { affectedRows: result.changes };
}

/**
 * 批量插入聚类结果到 face_clusters 表
 * @param {number} userId - 用户ID
 * @param {Array<Object>} clusterData - 聚类数据数组
 * @param {number} clusterData[].clusterId - 聚类ID（从 Python 服务返回）
 * @param {number} clusterData[].faceEmbeddingId - 人脸 embedding ID
 * @param {number} [clusterData[].similarityScore] - 相似度分数（可选）
 * @param {boolean} [clusterData[].isRepresentative] - 是否为代表人脸（可选，默认false）
 * @returns {Object} 返回对象 { affectedRows: 插入的行数 }
 */
function insertFaceClusters(userId, clusterData) {
  if (!clusterData || clusterData.length === 0) {
    return { affectedRows: 0 };
  }

  // 先验证所有 face_embedding_id 是否存在，过滤掉不存在的记录
  const validFaceEmbeddingIds = new Set();
  const checkSql = `SELECT id FROM media_face_embeddings WHERE id IN (${clusterData.map(() => "?").join(", ")})`;
  const checkStmt = db.prepare(checkSql);
  const faceEmbeddingIds = clusterData.map((item) => item.faceEmbeddingId);
  const existingRows = checkStmt.all(...faceEmbeddingIds);
  existingRows.forEach((row) => {
    validFaceEmbeddingIds.add(row.id);
  });

  // 过滤掉不存在的 face_embedding_id
  const validClusterData = clusterData.filter((item) => validFaceEmbeddingIds.has(item.faceEmbeddingId));
  const skippedCount = clusterData.length - validClusterData.length;

  if (skippedCount > 0) {
    logger.warn({
      message: `跳过 ${skippedCount} 条无效的 face_embedding_id`,
      details: { userId, total: clusterData.length, valid: validClusterData.length, skipped: skippedCount },
    });
  }

  if (validClusterData.length === 0) {
    return { affectedRows: 0 };
  }

  const sql = `
    INSERT OR IGNORE INTO face_clusters (
      user_id,
      cluster_id,
      face_embedding_id,
      similarity_score,
      representative_type,
      is_user_assigned,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const stmt = db.prepare(sql);
  const now = Date.now();
  let totalAffected = 0;

  const faceIdsToReplace = [...new Set(validClusterData.map((item) => item.faceEmbeddingId))];

  const transaction = db.transaction(() => {
    // 先移除这些脸上的「自动聚类」旧行，再插入新簇归属，避免 UNIQUE(user_id, cluster_id, face_embedding_id)
    // 下出现同脸跨簇双行；不删除 is_user_assigned 行
    if (faceIdsToReplace.length > 0) {
      const delSql = `
        DELETE FROM face_clusters
        WHERE user_id = ?
          AND face_embedding_id IN (${faceIdsToReplace.map(() => "?").join(",")})
          AND COALESCE(is_user_assigned, 0) = 0
      `;
      db.prepare(delSql).run(userId, ...faceIdsToReplace);
    }

    for (const item of validClusterData) {
      try {
        const result = stmt.run(
          userId,
          item.clusterId,
          item.faceEmbeddingId,
          item.similarityScore || null,
          item.representativeType ?? (item.isRepresentative ? 1 : 0),
          item.isUserAssigned ? 1 : 0, // SQLite 使用 0/1 表示布尔值，默认 FALSE（自动聚类）
          now,
        );
        totalAffected += result.changes;
      } catch (error) {
        logger.warn({
          message: `插入聚类数据失败: face_embedding_id=${item.faceEmbeddingId}`,
          details: { userId, clusterId: item.clusterId, error: error.message },
        });
      }
    }
  });

  transaction();

  return { affectedRows: totalAffected };
}

/**
 * 获取旧的聚类名称映射（重新聚类前调用，用于保留用户自定义的名称）
 * 注意：只获取自动聚类的名称（is_user_assigned = false），因为手动聚类的记录不会被删除，不需要恢复名称
 * @param {number} userId - 用户ID
 * @returns {Map<number, {name: string, faceEmbeddingIds: Set<number>}>} 映射：旧 cluster_id -> {名称, face_embedding_id 集合}
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
 * @param {number} userId - 用户ID
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
 * @param {number} userId - 用户ID
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
 * @param {number} userId - 用户ID
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

/**
 * 获取用户的聚类统计信息
 * @param {number} userId - 用户ID
 * @returns {Object} 聚类统计信息
 */
/**
 * 当前用户下已使用的最大 cluster_id（无记录时为 -1，便于后续从 max+1 起分配新 id）
 * @param {number} userId
 * @returns {number}
 */
function getMaxClusterIdForUser(userId) {
  const row = db.prepare(`SELECT MAX(cluster_id) AS m FROM face_clusters WHERE user_id = ?`).get(userId);
  if (row == null || row.m === null || row.m === undefined) return -1;
  return Number(row.m);
}

function getClusterStatsByUserId(userId) {
  const sql = `
    SELECT 
      COUNT(DISTINCT cluster_id) AS clusterCount,
      COUNT(*) AS totalFaces,
      COUNT(DISTINCT face_embedding_id) AS uniqueFaceCount
    FROM face_clusters
    WHERE user_id = ?
  `;

  const stmt = db.prepare(sql);
  const result = stmt.get(userId);

  return {
    clusterCount: result?.clusterCount || 0,
    totalFaces: result?.totalFaces || 0,
    uniqueFaceCount: result?.uniqueFaceCount || 0,
  };
}

/**
 * 获取指定聚类的所有人脸
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Array<Object>} 人脸列表
 */
/**
 * 获取指定聚类的所有人脸（支持分页）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {Object} options - 分页选项
 * @param {number} options.pageNo - 页码（从1开始）
 * @param {number} options.pageSize - 每页数量
 * @returns {Object} 返回 { list: [], total: 0 }
 */
function getFacesByClusterId(userId, clusterId, options = {}) {
  const { pageNo = 1, pageSize = 20 } = options;
  const offset = (pageNo - 1) * pageSize;

  // 先获取总数（必须应用与实际查询相同的过滤条件）
  const countSql = `
    SELECT COUNT(*) AS total
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? 
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
  `;
  const countStmt = db.prepare(countSql);
  const total = countStmt.get(userId, clusterId)?.total || 0;

  if (total === 0) {
    return { list: [], total: 0 };
  }

  // 查询数据（支持分页），只查询必要的字段
  // 注意：必须使用与总数查询相同的过滤条件，确保数据一致性
  const sql = `
    SELECT 
      m.id AS image_id,
      m.thumbnail_storage_key,
      m.high_res_storage_key,
      m.captured_at AS image_created_at,
      m.year_key,
      m.month_key,
      m.date_key
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? 
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
    ORDER BY 
      CASE 
        WHEN fc.representative_type = 2 THEN 1  -- 手动设置的封面优先级最高
        WHEN fc.representative_type = 1 THEN 2  -- 默认封面次之
        ELSE 3  -- 其他
      END,
      fc.similarity_score DESC, 
      m.captured_at DESC,
      fe.id ASC
    LIMIT ? OFFSET ?
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, clusterId, pageSize, offset);

  // 只返回必要的字段
  const list = rows.map((row) => ({
    imageId: row.image_id,
    thumbnailStorageKey: row.thumbnail_storage_key,
    highResStorageKey: row.high_res_storage_key,
    imageCreatedAt: row.image_created_at,
    yearKey: row.year_key,
    monthKey: row.month_key,
    dateKey: row.date_key,
  }));

  return { list, total };
}

/**
 * 获取用户的所有聚类列表（包含每个聚类的统计信息、封面、时间范围）
 * @param {number} userId - 用户ID
 * @param {Object} options - 查询选项
 * @param {number} options.pageNo - 页码（从1开始）
 * @param {number} options.pageSize - 每页数量
 * @returns {Object} 返回 { list: [], total: 0 }
 */
// 预编译常用查询语句（优化：避免每次调用都重新编译）
const preparedStatements = {
  count: null,
  basic: null,
  cover: null,
  time: null,
};

function getClustersByUserId(userId, options = {}) {
  const { pageNo = 1, pageSize = 20, search = null } = options;
  const offset = (pageNo - 1) * pageSize;
  const searchTrimmed = search && typeof search === "string" ? search.trim() : null;
  const hasSearch = searchTrimmed && searchTrimmed.length > 0;
  const searchPattern = hasSearch ? `%${searchTrimmed}%` : null;

  let total;
  if (hasSearch) {
    const countSql = `
      SELECT COUNT(DISTINCT fc.cluster_id) AS total
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM face_clusters fcx
          INNER JOIN media_face_embeddings fex ON fcx.face_embedding_id = fex.id
          INNER JOIN media mx ON fex.media_id = mx.id
          WHERE fcx.user_id = fc.user_id AND fcx.cluster_id = fc.cluster_id
            AND mx.deleted_at IS NULL
            AND fcx.name LIKE ?
        )
    `;
    const countStmt = db.prepare(countSql);
    total = countStmt.get(userId, searchPattern)?.total || 0;
  } else {
    if (!preparedStatements.count) {
      const countSql = `
        SELECT COUNT(DISTINCT fc.cluster_id) AS total
        FROM face_clusters fc
        INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
        INNER JOIN media m ON fe.media_id = m.id
        WHERE fc.user_id = ?
          AND m.deleted_at IS NULL
      `;
      preparedStatements.count = db.prepare(countSql);
    }
    total = preparedStatements.count.get(userId)?.total || 0;
  }

  // 添加调试日志：检查数据库中的原始数据
  if (total === 0) {
    // 检查是否有任何聚类数据（不考虑过滤条件）
    const rawCountSql = `SELECT COUNT(DISTINCT cluster_id) AS total FROM face_clusters WHERE user_id = ?`;
    const rawCountStmt = db.prepare(rawCountSql);
    const rawTotal = rawCountStmt.get(userId)?.total || 0;

    // 检查是否有被过滤掉的数据（只检查软删除的图片）
    const filteredCountSql = `
      SELECT COUNT(DISTINCT fc.cluster_id) AS total
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NOT NULL
    `;
    const filteredCountStmt = db.prepare(filteredCountSql);
    const filteredTotal = filteredCountStmt.get(userId)?.total || 0;

    logger.info({
      message: "人物列表查询：数据库检查",
      details: {
        userId,
        rawTotal,
        filteredTotal,
        finalTotal: total,
        message: rawTotal > 0 ? `数据库中有 ${rawTotal} 个聚类，但可能被过滤条件过滤掉了（deleted_at）` : "数据库中确实没有任何聚类数据",
      },
    });

    return { list: [], total: 0 };
  }

  // 第一步：查询聚类基本信息（按 cluster_id 聚合；name 取非空名的 MAX，避免 GROUP BY name 拆成同一人物两行）

  // 如果 SQLite 不支持窗口函数，使用更简单的方式
  // 只查询必要的字段：cluster_id, name, mediaCount
  // 注意：必须使用与总数查询相同的过滤条件，确保数据一致性
  // 使用 COUNT(DISTINCT m.id) 统计照片数量，而不是人脸数量
  let basicRows;
  if (hasSearch) {
    const basicSqlSearchRecent = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount,
        MAX(COALESCE(fcm.last_used_at, 0)) AS sort_last_used
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      LEFT JOIN face_cluster_meta fcm ON fcm.user_id = fc.user_id AND fcm.cluster_id = fc.cluster_id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM face_clusters fcx
          INNER JOIN media_face_embeddings fex ON fcx.face_embedding_id = fex.id
          INNER JOIN media mx ON fex.media_id = mx.id
          WHERE fcx.user_id = fc.user_id AND fcx.cluster_id = fc.cluster_id
            AND mx.deleted_at IS NULL
            AND fcx.name LIKE ?
        )
      GROUP BY fc.cluster_id
      ORDER BY sort_last_used DESC, (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    const basicSqlSearch = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM face_clusters fcx
          INNER JOIN media_face_embeddings fex ON fcx.face_embedding_id = fex.id
          INNER JOIN media mx ON fex.media_id = mx.id
          WHERE fcx.user_id = fc.user_id AND fcx.cluster_id = fc.cluster_id
            AND mx.deleted_at IS NULL
            AND fcx.name LIKE ?
        )
      GROUP BY fc.cluster_id
      ORDER BY (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    try {
      basicRows = db.prepare(basicSqlSearchRecent).all(userId, searchPattern, pageSize, offset);
    } catch (err) {
      logger.warn({ message: "getClustersByUserId 搜索使用默认排序", details: { error: err.message } });
      basicRows = db.prepare(basicSqlSearch).all(userId, searchPattern, pageSize, offset);
    }
  } else {
    // 只按 cluster_id 分组：name 在各行可能不一致（部分行 NULL），不能 GROUP BY cluster_id, name 否则同一人物会出现两行
    const basicSqlRecent = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount,
        MAX(COALESCE(fcm.last_used_at, 0)) AS sort_last_used
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      LEFT JOIN face_cluster_meta fcm ON fcm.user_id = fc.user_id AND fcm.cluster_id = fc.cluster_id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
      GROUP BY fc.cluster_id
      ORDER BY sort_last_used DESC, (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    const basicSqlSimple = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
      GROUP BY fc.cluster_id
      ORDER BY (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    try {
      basicRows = db.prepare(basicSqlRecent).all(userId, pageSize, offset);
    } catch (err) {
      logger.warn({ message: "getClustersByUserId 使用默认排序（可能 face_cluster_meta 不存在）", details: { error: err.message } });
      if (!preparedStatements.basic) {
        preparedStatements.basic = db.prepare(basicSqlSimple);
      }
      basicRows = preparedStatements.basic.all(userId, pageSize, offset);
    }
  }

  if (basicRows.length === 0) {
    return { list: [], total };
  }

  const clusterIds = basicRows.map((row) => row.cluster_id);

  // 第二步：批量查询封面图片（使用 IN 查询，一次性获取所有聚类的封面）
  // 优化（2025-12-03）：优先使用人脸缩略图作为封面，如果没有则使用整张图片
  // 只查询必要的字段：cluster_id, face_thumbnail_storage_key, thumbnail_storage_key
  const coverPlaceholders = clusterIds.map(() => "?").join(", ");
  const coverSql = `
    SELECT 
      fc.cluster_id,
      fe.face_thumbnail_storage_key,
      m.thumbnail_storage_key,
      fc.representative_type,
      fc.similarity_score
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id IN (${coverPlaceholders})
      AND m.deleted_at IS NULL
    ORDER BY fc.cluster_id, 
      CASE 
        WHEN fc.representative_type = 2 THEN 1  -- 手动设置的封面优先级最高
        WHEN fc.representative_type = 1 THEN 2  -- 默认封面次之
        ELSE 3  -- 其他
      END,
      fc.similarity_score DESC,
      fe.id ASC
  `;

  const coversMap = new Map();
  try {
    // 注意：由于 coverSql 中的 IN 子句参数数量是动态的，无法预编译
    // 但我们可以优化：对于常见的 pageSize（如 20），可以预编译几个常用版本
    const coverStmt = db.prepare(coverSql);
    const coverRows = coverStmt.all(userId, ...clusterIds);

    // 按 cluster_id 分组，每个聚类只取第一个（已按优先级排序）
    // 优先使用人脸缩略图，如果没有则使用整张图片的缩略图
    for (const row of coverRows) {
      if (!coversMap.has(row.cluster_id)) {
        // 优先使用人脸缩略图
        if (row.face_thumbnail_storage_key) {
          coversMap.set(row.cluster_id, {
            thumbnailStorageKey: row.face_thumbnail_storage_key,
          });
        } else if (row.thumbnail_storage_key) {
          // 降级：使用整张图片的缩略图
          coversMap.set(row.cluster_id, {
            thumbnailStorageKey: row.thumbnail_storage_key,
          });
        }
      }
    }

    // 调试日志：检查封面查询结果
    if (coverRows.length === 0 && clusterIds.length > 0) {
      console.warn(`警告：未找到任何封面图片，clusterIds: ${clusterIds.join(", ")}`);
    }
  } catch (error) {
    // 如果查询失败，继续执行，封面图片将为 null
    console.error("查询封面图片失败:", error);
  }

  // 第三步：批量查询时间范围（使用聚合函数）
  const timePlaceholders = clusterIds.map(() => "?").join(", ");
  const timeSql = `
    SELECT 
      fc.cluster_id,
      MIN(m.captured_at) AS earliest_time,
      MAX(m.captured_at) AS latest_time
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id IN (${timePlaceholders})
      AND m.deleted_at IS NULL
    GROUP BY fc.cluster_id
  `;

  // 注意：由于 timeSql 中的 IN 子句参数数量是动态的，无法预编译
  const timeStmt = db.prepare(timeSql);
  const timeRows = timeStmt.all(userId, ...clusterIds);
  const timeMap = new Map();
  for (const row of timeRows) {
    timeMap.set(row.cluster_id, {
      earliest: row.earliest_time,
      latest: row.latest_time,
    });
  }

  // 组装结果，只返回必要的字段
  const list = basicRows.map((row) => {
    const coverImage = coversMap.get(row.cluster_id) || null;
    const timeRange = timeMap.get(row.cluster_id) || null;

    return {
      clusterId: row.cluster_id,
      name: row.name || null,
      mediaCount: row.mediaCount,
      coverImage,
      timeRange,
    };
  });

  return { list, total };
}

/**
 * 获取最近使用的人物列表（用于 popover 第一屏）
 * 排序：最近使用 > 有名字 > 图片数量
 * @param {number} userId - 用户ID
 * @param {Object} options - 选项
 * @param {number} options.limit - 返回数量，默认 5
 * @param {number|null} options.excludeClusterId - 排除的人物 ID
 * @returns {Object} { list: [], total: 0 }
 */
function getRecentClustersByUserId(userId, options = {}) {
  const { limit = 5, excludeClusterId = null } = options;
  const excludeId = excludeClusterId != null && excludeClusterId !== "" ? parseInt(excludeClusterId, 10) : null;

  let whereClause = "fc.user_id = ? AND m.deleted_at IS NULL";
  const params = [userId];
  if (excludeId != null && !Number.isNaN(excludeId)) {
    whereClause += " AND fc.cluster_id != ?";
    params.push(excludeId);
  }

  // 总数（排除项后）
  let countSql = `
    SELECT COUNT(DISTINCT fc.cluster_id) AS total
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE ${whereClause}
  `;
  const total = db.prepare(countSql).get(...params)?.total || 0;

  // 基本查询：LEFT JOIN face_cluster_meta，按 最近使用 > 有名字 > 图片数量 排序（只按 cluster_id 分组）
  const basicSql = `
    SELECT 
      fc.cluster_id,
      MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
      COUNT(DISTINCT m.id) AS mediaCount,
      MAX(COALESCE(fcm.last_used_at, 0)) AS sort_last_used
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    LEFT JOIN face_cluster_meta fcm ON fcm.user_id = fc.user_id AND fcm.cluster_id = fc.cluster_id
    WHERE ${whereClause}
    GROUP BY fc.cluster_id
    ORDER BY sort_last_used DESC, (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
    LIMIT ?
  `;
  params.push(Math.min(limit, 20));

  let basicRows;
  try {
    basicRows = db.prepare(basicSql).all(...params);
  } catch (err) {
    // face_cluster_meta 表可能不存在
    logger.warn({ message: "getRecentClustersByUserId 回退到默认排序", details: { userId, error: err.message } });
    const fallbackParams = params.slice(0, -1);
    const fallbackSql = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE ${whereClause}
      GROUP BY fc.cluster_id
      ORDER BY (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ?
    `;
    fallbackParams.push(Math.min(limit, 20));
    basicRows = db.prepare(fallbackSql).all(...fallbackParams);
  }

  if (basicRows.length === 0) {
    return { list: [], total };
  }

  const clusterIds = basicRows.map((row) => row.cluster_id);
  const coverPlaceholders = clusterIds.map(() => "?").join(", ");
  const coverSql = `
    SELECT fc.cluster_id, fe.face_thumbnail_storage_key, m.thumbnail_storage_key, fc.representative_type, fc.similarity_score
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? AND fc.cluster_id IN (${coverPlaceholders}) AND m.deleted_at IS NULL
    ORDER BY fc.cluster_id, CASE WHEN fc.representative_type = 2 THEN 1 WHEN fc.representative_type = 1 THEN 2 ELSE 3 END, fc.similarity_score DESC, fe.id ASC
  `;
  const coverRows = db.prepare(coverSql).all(userId, ...clusterIds);
  const coversMap = new Map();
  for (const row of coverRows) {
    if (!coversMap.has(row.cluster_id)) {
      if (row.face_thumbnail_storage_key) {
        coversMap.set(row.cluster_id, { thumbnailStorageKey: row.face_thumbnail_storage_key });
      } else if (row.thumbnail_storage_key) {
        coversMap.set(row.cluster_id, { thumbnailStorageKey: row.thumbnail_storage_key });
      }
    }
  }

  const timePlaceholders = clusterIds.map(() => "?").join(", ");
  const timeRows = db.prepare(`
    SELECT fc.cluster_id, MIN(m.captured_at) AS earliest_time, MAX(m.captured_at) AS latest_time
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? AND fc.cluster_id IN (${timePlaceholders}) AND m.deleted_at IS NULL
    GROUP BY fc.cluster_id
  `).all(userId, ...clusterIds);
  const timeMap = new Map(timeRows.map((r) => [r.cluster_id, { earliest: r.earliest_time, latest: r.latest_time }]));

  const list = basicRows.map((row) => ({
    clusterId: row.cluster_id,
    name: row.name || null,
    mediaCount: row.mediaCount,
    coverImage: coversMap.get(row.cluster_id) || null,
    timeRange: timeMap.get(row.cluster_id) || null,
  }));

  return { list, total };
}

/**
 * 获取当前用户下已存在的人物名称（用于重名校验）
 * @param {number} userId - 用户ID
 * @param {number|null} excludeClusterId - 排除的 cluster_id（修改名称时排除当前人物）
 * @returns {string[]} 已存在的名称数组（trim 后非空）
 */
function getExistingPersonNames(userId, excludeClusterId = null) {
  const sql = `
    SELECT cluster_id, TRIM(name) AS name
    FROM face_clusters
    WHERE user_id = ? AND name IS NOT NULL AND TRIM(name) != ''
    GROUP BY cluster_id
  `;
  const rows = db.prepare(sql).all(userId);
  return rows
    .filter((r) => excludeClusterId == null || r.cluster_id !== excludeClusterId)
    .map((r) => r.name);
}

/**
 * 更新聚类名称
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {string|null} name - 名称（null 表示清除名称）
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function updateClusterName(userId, clusterId, name) {
  // SQLite 不支持 UPDATE ... LIMIT，所以我们需要先检查是否存在
  const checkSql = `
    SELECT COUNT(*) AS count
    FROM face_clusters
    WHERE user_id = ? AND cluster_id = ?
    LIMIT 1
  `;
  const checkStmt = db.prepare(checkSql);
  const exists = checkStmt.get(userId, clusterId)?.count > 0;

  if (!exists) {
    return { affectedRows: 0 };
  }

  // 更新该聚类的所有记录的 name 字段（因为 name 是 cluster 级别的属性）
  const sql = `
    UPDATE face_clusters
    SET name = ?, updated_at = ?
    WHERE user_id = ? AND cluster_id = ?
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(name || null, Date.now(), userId, clusterId);

  return { affectedRows: result.changes };
}

/**
 * 更新人物最近使用时间（移入/移出照片或新建时调用）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 */
function updateFaceClusterLastUsedAt(userId, clusterId) {
  const now = Date.now();
  const sql = `
    INSERT INTO face_cluster_meta (user_id, cluster_id, last_used_at)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id, cluster_id) DO UPDATE SET last_used_at = excluded.last_used_at
  `;
  try {
    db.prepare(sql).run(userId, clusterId, now);
  } catch (err) {
    // 表可能不存在（未迁移），忽略
    logger.warn({ message: "updateFaceClusterLastUsedAt 失败（可能 face_cluster_meta 表不存在）", details: { userId, clusterId, error: err.message } });
  }
}

/**
 * 从聚类中移除照片
 * 注意：此函数只负责从 face_clusters 表中删除记录
 * 如果用户需要将照片移动到另一个聚类，应该使用 moveFacesToCluster 函数
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {Array<number>} faceEmbeddingIds - 要移除的 face_embedding ID 数组
 * @returns {Object} 返回对象 { affectedRows: 删除的行数 }
 */
function removeFacesFromCluster(userId, clusterId, faceEmbeddingIds) {
  if (!faceEmbeddingIds || faceEmbeddingIds.length === 0) {
    return { affectedRows: 0 };
  }

  // 开始事务
  const transaction = db.transaction(() => {
    // 从 face_clusters 表中删除记录
    // 注意：移除操作实际上应该是移动到另一个聚类，这里只是删除旧的聚类关系
    // 如果后续需要支持"永久排除"，应该使用 moveFacesToCluster 移动到特殊聚类
    const deleteSql = `
      DELETE FROM face_clusters
      WHERE user_id = ? 
        AND cluster_id = ?
        AND face_embedding_id IN (${faceEmbeddingIds.map(() => "?").join(",")})
    `;
    const deleteStmt = db.prepare(deleteSql);
    const deleteResult = deleteStmt.run(userId, clusterId, ...faceEmbeddingIds);

    return { affectedRows: deleteResult.changes };
  });

  return transaction();
}

/**
 * 将照片从一个聚类移动到另一个聚类（或创建新聚类）
 * @param {number} userId - 用户ID
 * @param {number} sourceClusterId - 源聚类ID
 * @param {Array<number>} faceEmbeddingIds - 要移动的 face_embedding ID 数组
 * @param {number|null} targetClusterId - 目标聚类ID（null 表示创建新聚类）
 * @param {string|null} newClusterName - 新聚类的名称（仅在 targetClusterId 为 null 时使用）
 * @returns {Object} 返回对象 { affectedRows: 移动的行数, targetClusterId: 目标聚类ID }
 */
function moveFacesToCluster(userId, sourceClusterId, faceEmbeddingIds, targetClusterId = null, newClusterName = null) {
  if (!faceEmbeddingIds || faceEmbeddingIds.length === 0) {
    return { affectedRows: 0, targetClusterId: targetClusterId };
  }

  // 开始事务
  const transaction = db.transaction(() => {
    let finalTargetClusterId = targetClusterId;
    let clusterNameToUse = null;

    // 1. 如果目标聚类ID为null，需要创建新聚类
    if (!finalTargetClusterId) {
      // 获取当前最大的 cluster_id
      const maxClusterSql = `SELECT MAX(cluster_id) as max_cluster_id FROM face_clusters WHERE user_id = ?`;
      const maxClusterStmt = db.prepare(maxClusterSql);
      const maxResult = maxClusterStmt.get(userId);
      const maxClusterId = maxResult?.max_cluster_id || 0;
      finalTargetClusterId = maxClusterId + 1;

      clusterNameToUse = newClusterName || null;
    } else {
      // 目标聚类存在，尝试复用已有名称；如果传了新名称则优先使用
      // 注意：需要在插入前获取名称，因为插入后可能需要同步到所有记录
      const nameSql = `SELECT name FROM face_clusters WHERE user_id = ? AND cluster_id = ? AND name IS NOT NULL AND name != '' LIMIT 1`;
      const nameStmt = db.prepare(nameSql);
      const existingName = nameStmt.get(userId, finalTargetClusterId)?.name || null;
      clusterNameToUse = newClusterName || existingName || null;
    }

    // 2. 从源聚类中删除记录
    const deleteSql = `
      DELETE FROM face_clusters
      WHERE user_id = ? 
        AND cluster_id = ?
        AND face_embedding_id IN (${faceEmbeddingIds.map(() => "?").join(",")})
    `;
    const deleteStmt = db.prepare(deleteSql);
    deleteStmt.run(userId, sourceClusterId, ...faceEmbeddingIds);

    // 3. 在目标聚类中插入记录，并设置 is_user_assigned = TRUE（标记为用户手动分配）
    const insertSql = `
      INSERT OR REPLACE INTO face_clusters (
        user_id,
        cluster_id,
        face_embedding_id,
        similarity_score,
        representative_type,
        is_user_assigned,
        name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const insertStmt = db.prepare(insertSql);
    const now = Date.now();
    let insertedCount = 0;

    faceEmbeddingIds.forEach((faceEmbeddingId) => {
      try {
        const result = insertStmt.run(
          userId,
          finalTargetClusterId,
          faceEmbeddingId,
          null, // similarity_score 设为 null（因为是手动分配）
          0, // representative_type 设为 0（非代表）
          1, // is_user_assigned 设为 1（标记为用户手动分配，SQLite 使用 0/1 表示布尔值）
          clusterNameToUse,
          now,
          now,
        );
        insertedCount += result.changes; // 使用 result.changes 而不是简单的计数
      } catch (error) {
        logger.warn({
          message: `移动聚类数据失败: face_embedding_id=${faceEmbeddingId}`,
          details: { userId, sourceClusterId, targetClusterId: finalTargetClusterId, error: error.message },
        });
        // 注意：这里不抛出错误，继续处理其他记录，但会记录警告
      }
    });

    // 4. 确保该 cluster_id 的所有记录的 name 字段都是一致的
    // 因为 INSERT OR REPLACE 可能导致某些记录的 name 为 null
    // 如果 clusterNameToUse 不为空，则更新该 cluster_id 的所有记录的 name
    // 如果传了新名称，也要同步到所有已有记录
    if (clusterNameToUse) {
      const syncNameSql = `
        UPDATE face_clusters
        SET name = ?, updated_at = ?
        WHERE user_id = ? AND cluster_id = ?
      `;
      const syncNameStmt = db.prepare(syncNameSql);
      const syncResult = syncNameStmt.run(clusterNameToUse, now, userId, finalTargetClusterId);
      logger.info({
        message: `已同步聚类名称到所有记录: cluster_id=${finalTargetClusterId}, name="${clusterNameToUse}", updated=${syncResult.changes}条记录`,
        details: { userId, clusterId: finalTargetClusterId, name: clusterNameToUse },
      });
    }

    // 5. 方案 A：将目标 cluster 内所有行的 is_user_assigned 置为 TRUE，避免全量重跑时被拆散
    const markUserAssignedSql = `
      UPDATE face_clusters SET is_user_assigned = 1, updated_at = ? WHERE user_id = ? AND cluster_id = ?
    `;
    db.prepare(markUserAssignedSql).run(now, userId, finalTargetClusterId);

    // 6. 更新目标 cluster 的代表向量（用于后续增量匹配）
    computeAndUpsertClusterRepresentative(userId, finalTargetClusterId);

    // 7. 更新最近使用时间：目标人物 + 源人物（移入/移出都算使用）
    updateFaceClusterLastUsedAt(userId, finalTargetClusterId);
    updateFaceClusterLastUsedAt(userId, sourceClusterId);

    return { affectedRows: insertedCount, targetClusterId: finalTargetClusterId };
  });

  return transaction();
}

/**
 * 根据face_embedding_id列表获取完整的人脸信息（包括quality_score、bbox、pose等）
 * @param {Array<number>} faceEmbeddingIds - face_embedding ID数组
 * @returns {Array<Object>} 人脸信息列表
 */
function getFaceEmbeddingsByIds(faceEmbeddingIds) {
  if (!faceEmbeddingIds || faceEmbeddingIds.length === 0) {
    return [];
  }

  const placeholders = faceEmbeddingIds.map(() => "?").join(", ");
  const faceSql = `
    SELECT 
      fe.id,
      fe.media_id AS image_id,
      fe.face_index,
      fe.quality_score,
      fe.bbox,
      fe.pose,
      fe.expression,
      fe.face_thumbnail_storage_key,
      m.sharpness_score,
      m.captured_at AS image_created_at
    FROM media_face_embeddings fe
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fe.id IN (${placeholders})
      AND m.deleted_at IS NULL
  `;
  const stmt = db.prepare(faceSql);
  return stmt.all(...faceEmbeddingIds);
}

/**
 * 根据image_id列表获取图片清晰度信息
 * @param {Array<number>} imageIds - image ID数组
 * @returns {Map<number, Object>} 图片信息映射表（imageId -> {sharpness_score}）
 */
function getMediasSharpnessByIds(imageIds) {
  if (!imageIds || imageIds.length === 0) {
    return new Map();
  }

  const placeholders = imageIds.map(() => "?").join(", ");
  const imageSql = `
    SELECT m.id, m.sharpness_score
    FROM media m
    WHERE m.id IN (${placeholders})
  `;
  const stmt = db.prepare(imageSql);
  const rows = stmt.all(...imageIds);

  const imagesMap = new Map();
  rows.forEach((row) => {
    imagesMap.set(row.id, { sharpness_score: row.sharpness_score });
  });
  return imagesMap;
}

/**
 * 更新face_embeddings表的face_thumbnail_storage_key字段
 * @param {number} faceEmbeddingId - face_embedding ID
 * @param {string} thumbnailStorageKey - 缩略图存储键
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function updateFaceEmbeddingThumbnail(faceEmbeddingId, thumbnailStorageKey) {
  const updateSql = `
    UPDATE media_face_embeddings
    SET face_thumbnail_storage_key = ?
    WHERE id = ?
  `;
  const stmt = db.prepare(updateSql);
  const result = stmt.run(thumbnailStorageKey, faceEmbeddingId);
  return { affectedRows: result.changes };
}

/**
 * 验证 faceEmbeddingId 是否属于该 clusterId 和 userId
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number} faceEmbeddingId - face_embedding ID
 * @returns {boolean} 如果属于则返回 true，否则返回 false
 */
function verifyFaceEmbeddingInCluster(userId, clusterId, faceEmbeddingId) {
  const verifySql = `
    SELECT COUNT(*) AS count
    FROM face_clusters
    WHERE user_id = ? AND cluster_id = ? AND face_embedding_id = ?
  `;
  const stmt = db.prepare(verifySql);
  const result = stmt.get(userId, clusterId, faceEmbeddingId);
  return result.count > 0;
}

/**
 * 清除指定 cluster 的所有 representative_type 标记（置为 0）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function clearClusterRepresentatives(userId, clusterId) {
  const clearSql = `
    UPDATE face_clusters
    SET representative_type = 0
    WHERE user_id = ? AND cluster_id = ?
  `;
  const stmt = db.prepare(clearSql);
  const result = stmt.run(userId, clusterId);
  return { affectedRows: result.changes };
}

/**
 * 清除指定 cluster 的手动设置的封面标记（representative_type = 2）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function clearManualCoverRepresentative(userId, clusterId) {
  const clearSql = `
    UPDATE face_clusters
    SET representative_type = 0
    WHERE user_id = ? AND cluster_id = ? AND representative_type = 2
  `;
  const stmt = db.prepare(clearSql);
  const result = stmt.run(userId, clusterId);
  return { affectedRows: result.changes };
}

/**
 * 清除指定 cluster 的其他默认封面标记（representative_type = 1），但保留指定的 face_embedding_id
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number} keepFaceEmbeddingId - 要保留的 face_embedding_id（不修改其 representative_type）
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function clearOtherDefaultCoverRepresentative(userId, clusterId, keepFaceEmbeddingId) {
  const clearSql = `
    UPDATE face_clusters
    SET representative_type = 0
    WHERE user_id = ? 
      AND cluster_id = ? 
      AND representative_type = 1
      AND face_embedding_id != ?
  `;
  const stmt = db.prepare(clearSql);
  const result = stmt.run(userId, clusterId, keepFaceEmbeddingId);
  return { affectedRows: result.changes };
}

/**
 * 更新 face_clusters.representative_type，标记为代表人脸/封面类型
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number} faceEmbeddingId - face_embedding ID
 * @param {number} representativeValue - representative 值：1 表示默认封面，2 表示手动设置的封面
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function updateFaceClusterRepresentative(userId, clusterId, faceEmbeddingId, representativeValue = 1) {
  const updateSql = `
    UPDATE face_clusters
    SET representative_type = ?
    WHERE user_id = ? AND cluster_id = ? AND face_embedding_id = ?
  `;
  const stmt = db.prepare(updateSql);
  const result = stmt.run(representativeValue, userId, clusterId, faceEmbeddingId);
  return { affectedRows: result.changes };
}

/**
 * 获取指定 face_embedding_id 在当前 cluster 中的 representative_type
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number} faceEmbeddingId - face_embedding ID
 * @returns {number|null} representative_type（0, 1, 2 或 null）
 */
function getFaceEmbeddingRepresentativeValue(userId, clusterId, faceEmbeddingId) {
  const sql = `
    SELECT representative_type
    FROM face_clusters
    WHERE user_id = ? AND cluster_id = ? AND face_embedding_id = ?
  `;
  const stmt = db.prepare(sql);
  const row = stmt.get(userId, clusterId, faceEmbeddingId);
  return row ? row.representative_type : null;
}

/**
 * 根据缩略图存储键批量查询对应的 representative_type
 * @param {number} userId - 用户ID
 * @param {Array<string>} thumbnailStorageKeys - 缩略图存储键数组
 * @returns {Map<string, number>} 映射：thumbnailStorageKey -> representative_type（2 手动封面，1 默认封面，0 普通）
 */
function getRepresentativeStatusByThumbnailKeys(userId, thumbnailStorageKeys) {
  if (!thumbnailStorageKeys || thumbnailStorageKeys.length === 0) {
    return new Map();
  }

  const placeholders = thumbnailStorageKeys.map(() => "?").join(", ");
  const sql = `
    SELECT 
      fe.face_thumbnail_storage_key,
      MAX(fc.representative_type) AS representative_type
    FROM media_face_embeddings fe
    INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE m.user_id = ?
      AND fe.face_thumbnail_storage_key IN (${placeholders})
      AND m.deleted_at IS NULL
    GROUP BY fe.face_thumbnail_storage_key
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, ...thumbnailStorageKeys);

  const result = new Map();
  for (const row of rows) {
    result.set(row.face_thumbnail_storage_key, row.representative_type || 0);
  }

  return result;
}

// ==================== 人脸聚类代表向量（face_cluster_representatives）====================

/**
 * 获取指定 cluster 的代表向量
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {{ embedding: number[], updatedAt: number } | null}
 */
function getClusterRepresentative(userId, clusterId) {
  const sql = `SELECT representative_embedding, updated_at FROM face_cluster_representatives WHERE user_id = ? AND cluster_id = ?`;
  const row = db.prepare(sql).get(userId, clusterId);
  if (!row || !row.representative_embedding) return null;
  const embedding = JSON.parse(row.representative_embedding.toString());
  return { embedding, updatedAt: row.updated_at };
}

/**
 * 获取用户下所有 cluster 的代表向量（用于增量匹配）
 * @param {number} userId - 用户ID
 * @returns {Array<{ clusterId: number, embedding: number[], updatedAt: number }>}
 */
function getAllClusterRepresentativesByUserId(userId) {
  const sql = `SELECT cluster_id, representative_embedding, updated_at FROM face_cluster_representatives WHERE user_id = ?`;
  const rows = db.prepare(sql).all(userId);
  return rows.map((r) => ({
    clusterId: r.cluster_id,
    embedding: JSON.parse(r.representative_embedding.toString()),
    updatedAt: r.updated_at,
  }));
}

/**
 * 插入或更新 cluster 代表向量
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number[]} embeddingArray - 代表向量（与 face_embeddings.embedding 同维数）
 * @returns {Object} { affectedRows }
 */
function upsertClusterRepresentative(userId, clusterId, embeddingArray) {
  const now = Date.now();
  const blob = Buffer.from(JSON.stringify(embeddingArray));
  const sql = `
    INSERT INTO face_cluster_representatives (user_id, cluster_id, representative_embedding, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, cluster_id) DO UPDATE SET representative_embedding = excluded.representative_embedding, updated_at = excluded.updated_at
  `;
  const result = db.prepare(sql).run(userId, clusterId, blob, now);
  return { affectedRows: result.changes };
}

/**
 * 删除指定 cluster 的代表向量
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Object} { affectedRows }
 */
function deleteClusterRepresentative(userId, clusterId) {
  const sql = `DELETE FROM face_cluster_representatives WHERE user_id = ? AND cluster_id = ?`;
  const result = db.prepare(sql).run(userId, clusterId);
  return { affectedRows: result.changes };
}

/**
 * 获取指定 cluster 下所有人脸的 embedding 数组（用于计算质心）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {number[][]} 每行为一个 embedding
 */
function getEmbeddingsByClusterId(userId, clusterId) {
  const sql = `
    SELECT fe.embedding
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? AND fc.cluster_id = ? AND m.deleted_at IS NULL
  `;
  const rows = db.prepare(sql).all(userId, clusterId);
  return rows.map((r) => JSON.parse(r.embedding.toString()));
}

/**
 * 对多个人脸 embedding 求均值（质心），与 face_embeddings 维度一致
 * @param {number[][]} embeddings - 多个 embedding
 * @returns {number[] | null} 质心向量，空数组时返回 null
 */
function computeCentroidEmbedding(embeddings) {
  if (!embeddings || embeddings.length === 0) return null;
  const dim = embeddings[0].length;
  const sum = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) sum[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= embeddings.length;
  return sum;
}

/**
 * 根据该 cluster 下所有人脸 embedding 计算质心并写入 face_cluster_representatives
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Object} { updated: boolean, affectedRows: number } 若 cluster 无脸则 updated=false
 */
function computeAndUpsertClusterRepresentative(userId, clusterId) {
  const embeddings = getEmbeddingsByClusterId(userId, clusterId);
  const centroid = computeCentroidEmbedding(embeddings);
  if (!centroid) return { updated: false, affectedRows: 0 };
  const { affectedRows } = upsertClusterRepresentative(userId, clusterId, centroid);
  return { updated: true, affectedRows };
}

/**
 * 获取用户下未归属任何 cluster 的人脸（用于增量分配）
 * 条件：face_embeddings 通过 image 属于该用户、图片未删、且该 face_embedding_id 不在 face_clusters 中
 * @param {number} userId - 用户ID
 * @returns {Array<{ id: number, embedding: number[] }>}
 */
function getUnassignedFaceEmbeddingsByUserId(userId) {
  const sql = `
    SELECT fe.id, fe.embedding
    FROM media_face_embeddings fe
    INNER JOIN media m ON fe.media_id = m.id
    LEFT JOIN face_clusters fc ON fe.id = fc.face_embedding_id AND fc.user_id = ?
    WHERE m.user_id = ? AND m.deleted_at IS NULL AND fc.face_embedding_id IS NULL
    ORDER BY fe.id ASC
  `;
  const rows = db.prepare(sql).all(userId, userId);
  return rows.map((r) => ({
    id: r.id,
    embedding: JSON.parse(r.embedding.toString()),
  }));
}

/**
 * 获取指定 cluster 的所有 face_embedding_id 列表
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Array<number>} face_embedding_id 数组
 */
function getFaceEmbeddingIdsByClusterId(userId, clusterId) {
  const sql = `
    SELECT fc.face_embedding_id
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? 
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, clusterId);
  return rows.map((row) => row.face_embedding_id);
}

/**
 * 获取指定图片在该聚类下对应的人脸 face_embedding_id（每张图取一个，用于设置封面等）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {Array<number>} imageIds - 图片ID列表
 * @returns {Map<number, number>} imageId -> faceEmbeddingId
 */
function getFaceEmbeddingIdByMediaIdInCluster(userId, clusterId, imageIds) {
  const map = new Map();
  if (!imageIds || imageIds.length === 0) return map;

  const placeholders = imageIds.map(() => "?").join(", ");
  const sql = `
    SELECT fe.media_id AS imageId, MIN(fe.id) AS faceEmbeddingId
    FROM media_face_embeddings fe
    INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
    WHERE fc.user_id = ? AND fc.cluster_id = ? AND fe.media_id IN (${placeholders})
    GROUP BY fe.media_id
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, clusterId, ...imageIds);
  rows.forEach((row) => {
    map.set(row.imageId, row.faceEmbeddingId);
  });
  return map;
}

/**
 * 获取聚类时生成的默认封面 face_embedding_id
 * 直接查找 representative_type = 1 的记录（默认封面）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {number|null} 默认封面的 face_embedding_id，如果找不到则返回 null
 */
function getDefaultCoverFaceEmbeddingId(userId, clusterId) {
  const sql = `
    SELECT fc.face_embedding_id
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? 
      AND fc.cluster_id = ?
      AND fc.representative_type = 1
      AND m.deleted_at IS NULL
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  const row = stmt.get(userId, clusterId);
  return row ? row.face_embedding_id : null;
}

/**
 * 获取用户当前作为封面的 face_embedding_id 列表（默认封面=1，手动封面=2）
 * @param {number} userId - 用户ID
 * @returns {number[]} face_embedding_id 列表
 */
function getRepresentativeFaceEmbeddingIdsByUserId(userId) {
  const sql = `
    SELECT DISTINCT fc.face_embedding_id
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.representative_type IN (1, 2)
      AND m.deleted_at IS NULL
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId);
  return rows.map((row) => row.face_embedding_id).filter((id) => id != null);
}

/**
 * 设置聚类封面（手动设置）：设置为 representative_type = 2，保留默认封面（representative_type = 1）不变
 * 如果手动设置的就是默认封面本身（representative_type = 1），则保持为 1，不改为 2
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number} faceEmbeddingId - face_embedding ID
 * @returns {Object} 返回对象 { affectedRows: 更新的行数, isDefaultCover: 是否为默认封面 }
 */
function setClusterCover(userId, clusterId, faceEmbeddingId) {
  // 1. 验证 faceEmbeddingId 是否属于该 cluster
  if (!verifyFaceEmbeddingInCluster(userId, clusterId, faceEmbeddingId)) {
    return { affectedRows: 0, error: "faceEmbeddingId does not belong to this cluster" };
  }

  // 2. 检查当前要设置的 face_embedding_id 是否已经是默认封面（representative_type = 1）
  const currentValue = getFaceEmbeddingRepresentativeValue(userId, clusterId, faceEmbeddingId);
  if (currentValue === 1) {
    // 如果已经是默认封面，则不需要做任何操作，保持为 1
    // 但需要清除其他手动设置的封面（representative_type = 2），确保只有这一个 1
    clearManualCoverRepresentative(userId, clusterId);
    return { affectedRows: 0, isDefaultCover: true };
  }

  // 3. 清除该 cluster 中其他手动设置的封面（representative_type = 2），保留默认封面（representative_type = 1）
  clearManualCoverRepresentative(userId, clusterId);

  // 4. 设置新的手动封面为 representative_type = 2
  const result = updateFaceClusterRepresentative(userId, clusterId, faceEmbeddingId, 2);
  return { ...result, isDefaultCover: false };
}

/**
 * 恢复默认封面：清除手动设置的封面（representative_type = 2），确保默认封面（representative_type = 1）存在且唯一
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @param {number} defaultFaceEmbeddingId - 默认封面的 face_embedding_id
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 */
function restoreClusterDefaultCover(userId, clusterId, defaultFaceEmbeddingId) {
  // 1. 清除手动设置的封面（representative_type = 2）
  clearManualCoverRepresentative(userId, clusterId);

  // 2. 清除其他可能的默认封面（representative_type = 1），确保只有指定的默认封面是 1
  clearOtherDefaultCoverRepresentative(userId, clusterId, defaultFaceEmbeddingId);

  // 3. 确保默认封面存在（如果不存在，设置为 representative_type = 1）
  // 注意：如果 defaultFaceEmbeddingId 对应的记录不存在或不属于该 cluster，updateFaceClusterRepresentative 会返回 affectedRows = 0
  return updateFaceClusterRepresentative(userId, clusterId, defaultFaceEmbeddingId, 1);
}

module.exports = {
  getFaceEmbeddingsByUserId,
  getOldThumbnailPathsByUserId,
  deleteFaceClustersByUserId,
  insertFaceClusters,
  getMaxClusterIdForUser,
  getClusterStatsByUserId,
  getFacesByClusterId,
  getClustersByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  removeFacesFromCluster,
  moveFacesToCluster,
  getFaceEmbeddingsByIds,
  getMediasSharpnessByIds,
  updateFaceEmbeddingThumbnail,
  updateFaceClusterRepresentative,
  getOldClusterNameMapping,
  getOldCoverMapping,
  restoreClusterNames,
  restoreCoverSettings,
  verifyFaceEmbeddingInCluster,
  clearClusterRepresentatives,
  clearManualCoverRepresentative,
  clearOtherDefaultCoverRepresentative,
  setClusterCover,
  restoreClusterDefaultCover,
  getFaceEmbeddingIdsByClusterId,
  getFaceEmbeddingIdByMediaIdInCluster,
  getFaceEmbeddingRepresentativeValue,
  getRepresentativeStatusByThumbnailKeys,
  getDefaultCoverFaceEmbeddingId,
  getRepresentativeFaceEmbeddingIdsByUserId,
  getClusterRepresentative,
  getAllClusterRepresentativesByUserId,
  upsertClusterRepresentative,
  deleteClusterRepresentative,
  getEmbeddingsByClusterId,
  computeCentroidEmbedding,
  computeAndUpsertClusterRepresentative,
  getUnassignedFaceEmbeddingsByUserId,
};
