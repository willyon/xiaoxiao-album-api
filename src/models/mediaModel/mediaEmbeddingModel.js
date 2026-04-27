/**
 * 媒体向量模型：负责 media_embeddings 的向量写入、删除与视觉文本召回读取。
 */
const { db } = require("../../db");

const MEDIA_EMBEDDING_SOURCE_TYPES = {
  IMAGE: "image",
  VISUAL_TEXT: "visual_text",
};

/**
 * 将数值向量编码为 Float32 的 Buffer。
 * @param {number[]} [vector=[]] 向量
 * @returns {Buffer} 二进制向量
 */
function _vectorToBlob(vector = []) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return Buffer.alloc(0);
  }
  const floatArray = new Float32Array(vector.map((v) => Number(v) || 0));
  return Buffer.from(floatArray.buffer);
}

/**
 * 将向量 Buffer 反解为 number[]。
 * @param {Buffer} blob 向量 Buffer
 * @returns {number[]} 向量数组
 */
function _blobToVector(blob) {
  if (!Buffer.isBuffer(blob) || blob.length === 0) {
    return [];
  }
  const arrayBuffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float32Array(arrayBuffer));
}

/**
 * 按 sourceType 上插媒体向量。
 * @param {{mediaId:number,sourceType:string,vector:number[],createdAt?:number}} params 入参
 * @returns {{changes:number}} 执行结果
 */
function upsertMediaEmbeddingBySourceType({ mediaId, sourceType, vector, createdAt }) {
  if (!mediaId || !sourceType) {
    return { changes: 0 };
  }
  const blob = _vectorToBlob(vector);
  const now = createdAt || Date.now();

  const stmt = db.prepare(`
    INSERT INTO media_embeddings (media_id, source_type, source_ref_id, vector, created_at)
    VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(media_id, source_type) DO UPDATE SET
      vector = excluded.vector,
      created_at = excluded.created_at
  `);

  return stmt.run(mediaId, sourceType, blob, now);
}

/**
 * 上插图片主向量（sourceType=image）。
 * @param {{mediaId:number,vector:number[],createdAt?:number}} params 入参
 * @returns {{changes:number}} 执行结果
 */
function upsertMediaEmbedding({ mediaId, vector, createdAt }) {
  return upsertMediaEmbeddingBySourceType({
    mediaId,
    sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.IMAGE,
    vector,
    createdAt,
  });
}

/**
 * 删除指定 sourceType 的媒体向量。
 * @param {{mediaId:number,sourceType:string}} params 入参
 * @returns {{changes:number}} 执行结果
 */
function deleteMediaEmbeddingBySourceType({ mediaId, sourceType }) {
  if (!mediaId || !sourceType) {
    return { changes: 0 };
  }
  return db.prepare("DELETE FROM media_embeddings WHERE media_id = ? AND source_type = ?").run(mediaId, sourceType);
}

/**
 * 拉取视觉文本向量召回候选行。
 * @param {{userId:number,whereConditions?:string[],whereParams?:any[]}} [params={}] 查询参数
 * @returns {Array<{media_id:number,vector:number[],description_text:string}>} 候选行
 */
function listVisualTextEmbeddingRowsForRecall({ userId, whereConditions = [], whereParams = [] } = {}) {
  let sql = `
    SELECT
      i.id AS media_id,
      me.vector,
      ms.description_text AS description_text
    FROM media_embeddings me
    JOIN media i ON i.id = me.media_id
    LEFT JOIN media_search ms ON ms.media_id = i.id
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND me.source_type = ?
  `;
  if (whereConditions.length > 0) {
    sql += " AND " + whereConditions.join(" AND ");
  }
  const rows = db.prepare(sql).all(userId, MEDIA_EMBEDDING_SOURCE_TYPES.VISUAL_TEXT, ...whereParams);
  return rows.map((row) => ({
    media_id: row.media_id,
    vector: _blobToVector(row.vector),
    description_text: row.description_text != null ? String(row.description_text) : "",
  }));
}

module.exports = {
  MEDIA_EMBEDDING_SOURCE_TYPES,
  upsertMediaEmbeddingBySourceType,
  upsertMediaEmbedding,
  deleteMediaEmbeddingBySourceType,
  listVisualTextEmbeddingRowsForRecall,
};
