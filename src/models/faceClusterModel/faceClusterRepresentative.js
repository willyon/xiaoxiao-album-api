/*
 * @Description: face_clusters.representative_type 与 face_cluster_representatives 代表向量、封面选择
 */
/**
 * 人脸聚类代表模型：封面类型维护、质心与代表向量 upsert、设置/恢复默认与手动封面。
 */
const { db } = require('../../db')
const { verifyFaceEmbeddingInCluster } = require('./faceClusterVerification')

/**
 * 清除指定 cluster 的手动设置的封面标记（representative_type = 2）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {{affectedRows:number}} 返回对象 { affectedRows: 更新的行数 }。
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
 * @returns {{affectedRows:number}} 返回对象 { affectedRows: 更新的行数 }。
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
 * @returns {{affectedRows:number}} 返回对象 { affectedRows: 更新的行数 }。
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
 * 当前聚类中所有「手动封面」的 face_embedding_id（representative_type = 2；默认封面 1 不会出现在此列表中）
 * @param {number|string} userId - 用户 ID
 * @param {number|string} clusterId - 聚类 ID
 * @returns {number[]}
 */
function getManualCoverFaceEmbeddingIds(userId, clusterId) {
  const sql = `
    SELECT face_embedding_id
    FROM face_clusters
    WHERE user_id = ? AND cluster_id = ? AND representative_type = 2
  `;
  return db
    .prepare(sql)
    .all(userId, clusterId)
    .map((r) => r.face_embedding_id);
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
 * @returns {{affectedRows:number}} 执行结果。
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
 * @returns {{updated:boolean,affectedRows:number}} 若 cluster 无脸则 updated=false。
 */
function computeAndUpsertClusterRepresentative(userId, clusterId) {
  const embeddings = getEmbeddingsByClusterId(userId, clusterId);
  const centroid = computeCentroidEmbedding(embeddings);
  if (!centroid) return { updated: false, affectedRows: 0 };
  const { affectedRows } = upsertClusterRepresentative(userId, clusterId, centroid);
  return { updated: true, affectedRows };
}

/**
 * 将某人脸设为该人物的手动封面（representative_type=2），并清理同簇其它手动封面；若该脸已是默认封面则只清理手动封面
 * @param {number} userId 用户 ID
 * @param {number} clusterId 聚类 ID
 * @param {number} faceEmbeddingId 人脸 embedding id
 * @returns {{ affectedRows: number, isDefaultCover?: boolean, error?: string }} 更新结果或错误说明
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
 * @returns {{affectedRows:number}} 返回对象 { affectedRows: 更新的行数 }。
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
  clearManualCoverRepresentative,
  clearOtherDefaultCoverRepresentative,
  updateFaceClusterRepresentative,
  getFaceEmbeddingRepresentativeValue,
  getManualCoverFaceEmbeddingIds,
  getRepresentativeStatusByThumbnailKeys,
  getAllClusterRepresentativesByUserId,
  computeAndUpsertClusterRepresentative,
  setClusterCover,
  restoreClusterDefaultCover,
}
