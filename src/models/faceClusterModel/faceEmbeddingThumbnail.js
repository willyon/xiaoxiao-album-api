/*
 * @Description: media_face_embeddings 缩略图字段与关联 media 的清晰度等展示字段
 */
/**
 * 人脸缩略图模型：按 embedding id 批量查询人脸行、媒体清晰度得分、回写人脸缩略图存储键。
 */
const { db } = require('../../db')

/**
 * 按 embedding id 批量查询人脸行及关联媒体的清晰度、拍摄时间等（未删除媒体）
 * @param {Array<number|string>} faceEmbeddingIds 人脸 embedding id 列表
 * @returns {Array<object>} 查询结果行
 */
function getFaceEmbeddingsByIds(faceEmbeddingIds) {
  if (!faceEmbeddingIds || faceEmbeddingIds.length === 0) {
    return [];
  }

  const placeholders = faceEmbeddingIds.map(() => "?").join(", ");
  const faceSql = `
    SELECT 
      fe.id,
      fe.media_id,
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
 * 根据 media id 列表获取图片清晰度信息
 * @param {Array<number|string>} mediaIds - 媒体 ID 数组
 * @returns {Map<number, {sharpness_score:number|null}>} 媒体信息映射表（mediaId -> {sharpness_score}）
 */
function getMediasSharpnessByIds(mediaIds) {
  if (!mediaIds || mediaIds.length === 0) {
    return new Map();
  }

  const placeholders = mediaIds.map(() => "?").join(", ");
  const imageSql = `
    SELECT m.id, m.sharpness_score
    FROM media m
    WHERE m.id IN (${placeholders})
  `;
  const stmt = db.prepare(imageSql);
  const rows = stmt.all(...mediaIds);

  const imagesMap = new Map();
  rows.forEach((row) => {
    imagesMap.set(row.id, { sharpness_score: row.sharpness_score });
  });
  return imagesMap;
}

/**
 * 更新face_embeddings表的face_thumbnail_storage_key字段
 * @param {number|string} faceEmbeddingId - face_embedding ID
 * @param {string} thumbnailStorageKey - 缩略图存储键
 * @returns {{affectedRows:number}} 返回对象 { affectedRows: 更新的行数 }
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
 * 清除指定人脸行的人像缩略图 storage key（置 NULL），不删对象存储；删文件在业务层与调用方配合。
 * @param {number|string} faceEmbeddingId - face_embedding id
 * @returns {{ affectedRows: number }} 更新行数
 */
function clearFaceThumbnailStorageKeyForEmbeddingId(faceEmbeddingId) {
  const run = db
    .prepare(
      `UPDATE media_face_embeddings SET face_thumbnail_storage_key = NULL WHERE id = ?`
    )
    .run(faceEmbeddingId);
  return { affectedRows: run.changes };
}

module.exports = {
  getFaceEmbeddingsByIds,
  getMediasSharpnessByIds,
  updateFaceEmbeddingThumbnail,
  clearFaceThumbnailStorageKeyForEmbeddingId
}
