const { db } = require("../services/database");

const MEDIA_EMBEDDING_SOURCE_TYPES = {
  IMAGE: "image",
  VISUAL_TEXT: "visual_text",
};

function _vectorToBlob(vector = []) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return Buffer.alloc(0);
  }
  const floatArray = new Float32Array(vector.map((v) => Number(v) || 0));
  return Buffer.from(floatArray.buffer);
}

function _blobToVector(blob) {
  if (!Buffer.isBuffer(blob) || blob.length === 0) {
    return [];
  }
  const arrayBuffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float32Array(arrayBuffer));
}

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

function upsertMediaEmbedding({ imageId, vector, createdAt }) {
  return upsertMediaEmbeddingBySourceType({
    mediaId: imageId,
    sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.IMAGE,
    vector,
    createdAt,
  });
}

function deleteMediaEmbeddingBySourceType({ mediaId, sourceType }) {
  if (!mediaId || !sourceType) {
    return { changes: 0 };
  }
  return db.prepare("DELETE FROM media_embeddings WHERE media_id = ? AND source_type = ?").run(mediaId, sourceType);
}

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
