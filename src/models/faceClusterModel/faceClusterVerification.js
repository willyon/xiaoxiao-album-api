/*
 * @Description: face_clusters 归属校验（某 face_embedding 是否属于指定 cluster）
 */
/**
 * 人脸聚类校验模型：提供人脸与聚类绑定关系的存在性查询。
 */
const { db } = require('../../db')

/**
 * 判断指定人脸 embedding 是否已归属某聚类（face_clusters 中存在对应行）
 * @param {number} userId 用户 ID
 * @param {number} clusterId 聚类 ID
 * @param {number} faceEmbeddingId 人脸 embedding 行 ID
 * @returns {boolean} 存在则为 true
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

module.exports = {
  verifyFaceEmbeddingInCluster
}
