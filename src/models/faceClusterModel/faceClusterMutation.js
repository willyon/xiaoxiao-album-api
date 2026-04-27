/*
 * @Description: face_clusters 人物名称更新、跨 cluster 移脸事务、face_cluster_meta 最近使用时间
 */
/**
 * 人脸聚类变更模型：更新聚类展示名、移动人脸至目标人物并维护代表向量与使用时间。
 */
const { db } = require('../../db')
const logger = require('../../utils/logger')
const { computeAndUpsertClusterRepresentative } = require('./faceClusterRepresentative')

/**
 * 更新某人物（cluster）下所有 face_clusters 行的展示名称
 * @param {number} userId 用户 ID
 * @param {number} clusterId 聚类 ID
 * @param {string|null|undefined} name 名称，空则置为 null
 * @returns {{ affectedRows: number }} 更新行数（聚类不存在时为 0）
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
 * @returns {void} 无返回值。
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
 * 将照片从一个聚类移动到另一个聚类（或创建新聚类）
 * @param {number} userId - 用户ID
 * @param {number} sourceClusterId - 源聚类ID
 * @param {Array<number>} faceEmbeddingIds - 要移动的 face_embedding ID 数组
 * @param {number|null} targetClusterId - 目标聚类ID（null 表示创建新聚类）
 * @param {string|null} newClusterName - 新聚类的名称（仅在 targetClusterId 为 null 时使用）
 * @returns {{affectedRows:number,targetClusterId:number|null}} 返回对象 { affectedRows: 移动的行数, targetClusterId: 目标聚类ID }。
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

module.exports = {
  updateClusterName,
  moveFacesToCluster
}
