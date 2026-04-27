/*
 * @Description: face_clusters 批量删除与聚类结果批量插入（Python 聚类回写）
 */
/**
 * 人脸聚类批量模型：重新聚类前清空用户聚类数据、批量插入聚类行、查询新 cluster_id 上限。
 */
const { db } = require('../../db')
const logger = require('../../utils/logger')

/**
 * 删除用户下聚类行（重新聚类前清空）
 * @param {number} userId 用户 ID
 * @param {Object} [options] 选项
 * @param {boolean} [options.excludeUserAssigned] 为 true 时保留用户手动分配的行
 * @returns {{ affectedRows: number }} 删除行数。
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
 * @param {Array<{clusterId:number,faceEmbeddingId:number,similarityScore?:number,isRepresentative?:boolean,representativeType?:number,isUserAssigned?:boolean}>} clusterData - 聚类数据数组。
 * @param {{replaceAutoExisting?:boolean}} [options] 选项；为 true 时在同一事务内先删除该用户自动聚类旧行。
 * @param {number} clusterData[].clusterId - 聚类ID（从 Python 服务返回）
 * @param {number} clusterData[].faceEmbeddingId - 人脸 embedding ID
 * @param {number} [clusterData[].similarityScore] - 相似度分数（可选）
 * @param {boolean} [clusterData[].isRepresentative] - 是否为代表人脸（可选，默认false）
 * @returns {{affectedRows:number}} 返回对象 { affectedRows: 插入的行数 }。
 */
function insertFaceClusters(userId, clusterData, options = {}) {
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
    if (options.replaceAutoExisting) {
      db.prepare(
        `
        DELETE FROM face_clusters
        WHERE user_id = ?
          AND (is_user_assigned IS NULL OR is_user_assigned = FALSE)
      `,
      ).run(userId);
    }

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
 * 查询用户当前最大的 cluster_id（无数据时返回 -1）
 * @param {number} userId 用户 ID
 * @returns {number} 最大 cluster_id，若无行则为 -1
 */
function getMaxClusterIdForUser(userId) {
  const row = db.prepare(`SELECT MAX(cluster_id) AS m FROM face_clusters WHERE user_id = ?`).get(userId);
  if (row == null || row.m === null || row.m === undefined) return -1;
  return Number(row.m);
}

module.exports = {
  deleteFaceClustersByUserId,
  insertFaceClusters,
  getMaxClusterIdForUser
}
