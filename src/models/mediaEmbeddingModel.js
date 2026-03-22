const { db } = require("../services/database");

function _vectorToBlob(vector = []) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return Buffer.alloc(0);
  }
  const floatArray = new Float32Array(vector.map((v) => Number(v) || 0));
  return Buffer.from(floatArray.buffer);
}

function upsertMediaEmbedding({ imageId, vector, createdAt }) {
  const blob = _vectorToBlob(vector);
  const now = createdAt || Date.now();
  const sourceType = "image";

  const stmt = db.prepare(`
    INSERT INTO media_embeddings (media_id, source_type, source_ref_id, vector, created_at, analysis_version)
    VALUES (?, ?, NULL, ?, ?, '1.0')
    ON CONFLICT(media_id, source_type) DO UPDATE SET
      vector = excluded.vector,
      created_at = excluded.created_at,
      analysis_version = excluded.analysis_version
  `);

  return stmt.run(imageId, sourceType, blob, now);
}

module.exports = {
  upsertMediaEmbedding,
};
