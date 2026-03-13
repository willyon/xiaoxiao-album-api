const { db } = require("../services/database");

function _vectorToBlob(vector = []) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return Buffer.alloc(0);
  }
  const floatArray = new Float32Array(vector.map((v) => Number(v) || 0));
  return Buffer.from(floatArray.buffer);
}

function _blobToVector(blob) {
  if (!blob || blob.length === 0) {
    return null;
  }
  const floatArray = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floatArray);
}

function upsertMediaEmbedding({ imageId, vector, modelId, createdAt }) {
  const blob = _vectorToBlob(vector);
  const now = createdAt || Date.now();
  const sourceType = "image";

  const stmt = db.prepare(`
    INSERT INTO media_embeddings (media_id, source_type, source_ref_id, vector, model_id, created_at, analysis_version)
    VALUES (?, ?, NULL, ?, ?, ?, '1.0')
    ON CONFLICT(media_id, model_id, source_type) DO UPDATE SET
      vector = excluded.vector,
      model_id = excluded.model_id,
      created_at = excluded.created_at,
      analysis_version = excluded.analysis_version
  `);

  return stmt.run(imageId, sourceType, blob, modelId || "siglip2", now);
}

function getMediaEmbedding(imageId) {
  const stmt = db.prepare(`
    SELECT vector, model_id
    FROM media_embeddings
    WHERE media_id = ?
      AND source_type = 'image'
    LIMIT 1
  `);
  const row = stmt.get(imageId);
  if (!row || !row.vector) {
    return null;
  }
  return {
    vector: _blobToVector(row.vector),
    modelId: row.model_id || "siglip2",
  };
}

/**
 * 获取用户的所有图片 embedding（用于向量搜索）
 * @param {number} userId - 用户ID
 * @param {number} limit - 最大返回数量（避免单次请求过大，默认 5000）
 * @returns {Array<{imageId: number, vector: number[]}>} 图片 embedding 列表
 */
function getMediaEmbeddingsByUserId(userId, limit = 5000) {
  const sql = `
    SELECT e.media_id as imageId, e.vector, e.model_id
    FROM media_embeddings e
    INNER JOIN media i ON e.media_id = i.id
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND e.source_type = 'image'
    LIMIT ?
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, limit);

  return rows
    .filter((row) => row.vector && row.vector.length > 0)
    .map((row) => ({
      imageId: row.imageId,
      vector: _blobToVector(row.vector),
      modelId: row.model_id || "siglip2",
    }));
}

module.exports = {
  upsertMediaEmbedding,
  getMediaEmbedding,
  getMediaEmbeddingsByUserId,
};
