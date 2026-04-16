const { db } = require('../db')
const { generateTextEmbeddingForDocument } = require('./embeddingProvider')
const mediaModel = require('../models/mediaModel')
const { MEDIA_EMBEDDING_SOURCE_TYPES, upsertMediaEmbeddingBySourceType, deleteMediaEmbeddingBySourceType } = mediaModel

function getMediaSearchRow(mediaId) {
  return db
    .prepare(
      `
      SELECT ms.media_id, ms.description_text
      FROM media_search ms
      JOIN media i ON i.id = ms.media_id
      WHERE ms.media_id = ?
        AND i.deleted_at IS NULL
    `
    )
    .get(mediaId)
}

async function rebuildMediaEmbeddingDoc(mediaId) {
  const row = getMediaSearchRow(mediaId)
  if (!row) {
    deleteMediaEmbeddingBySourceType({
      mediaId,
      sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.VISUAL_TEXT
    })
    return { affectedRows: 0, deleted: true, skipped: false }
  }

  const visualText = row.description_text != null ? String(row.description_text).trim() : ''
  if (!visualText) {
    deleteMediaEmbeddingBySourceType({
      mediaId,
      sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.VISUAL_TEXT
    })
    return { affectedRows: 0, deleted: true, skipped: true }
  }

  const vector = await generateTextEmbeddingForDocument(visualText)
  if (!Array.isArray(vector) || vector.length === 0) {
    return { affectedRows: 0, deleted: false, skipped: true }
  }

  const result = upsertMediaEmbeddingBySourceType({
    mediaId,
    sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.VISUAL_TEXT,
    vector,
    createdAt: Date.now()
  })
  return { affectedRows: result.changes || 0, deleted: false, skipped: false }
}

module.exports = {
  rebuildMediaEmbeddingDoc
}
