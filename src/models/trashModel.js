/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 回收站数据模型 - 处理已删除图片的查询、恢复、彻底删除等操作
 */

const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");

/**
 * 分页查询用户已删除的图片
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量
 * @param {string} [params.mediaType] - 媒体类型：'all' | 'image' | 'video'
 * @returns {Object} { data: Array, total: number }
 */
function selectDeletedMediasByPage({ userId, pageNo, pageSize, mediaType }) {
  const offset = (pageNo - 1) * pageSize;

  const mediaCondition =
    mediaType && mediaType !== "all" ? " AND (COALESCE(media_type, 'image') = ?)" : "";
  const mediaParam = mediaType && mediaType !== "all" ? [mediaType] : [];

  const dataQuery = db.prepare(`
    SELECT 
      id,
      media_type,
      high_res_storage_key,
      thumbnail_storage_key,
      original_storage_key,
      captured_at,
      gps_location,
      day_key,
      width_px,
      height_px,
      aspect_ratio,
      layout_type,
      file_size_bytes,
      is_favorite,
      duration_sec
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NOT NULL
      ${mediaCondition}
    ORDER BY deleted_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NOT NULL
      ${mediaCondition}
  `);

  try {
    const data = dataQuery.all(userId, ...mediaParam, pageSize, offset);
    const { total } = countQuery.get(userId, ...mediaParam);

    return {
      data: mapFields("media", data),
      total: total || 0,
    };
  } catch (error) {
    throw error;
  }
}

/**
 * 查询指定ID的已删除图片（用于权限验证）
 * @param {number} userId - 用户ID
 * @param {Array<number>} imageIds - 图片ID数组
 * @returns {Array} 图片信息数组
 */
function selectDeletedMediasByIds(userId, imageIds) {
  if (!imageIds || imageIds.length === 0) return [];
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT 
      id,
      user_id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key,
      deleted_at
    FROM media
    WHERE user_id = ?
      AND id IN (${placeholders})
      AND deleted_at IS NOT NULL
  `);
  return stmt.all(userId, ...imageIds);
}

/**
 * 恢复图片（将 deleted_at 设为 NULL）
 * @param {Array<number>} imageIds - 图片ID数组
 * @returns {Object} { changes: number }
 */
function restoreMedias(imageIds) {
  if (!imageIds || imageIds.length === 0) return { changes: 0 };
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    UPDATE media
    SET deleted_at = NULL
    WHERE id IN (${placeholders})
      AND deleted_at IS NOT NULL
  `);
  return stmt.run(...imageIds);
}

/**
 * 彻底删除图片（物理删除数据库记录，仅限回收站内 deleted_at IS NOT NULL）
 * @param {Array<number>} imageIds - 图片ID数组（必须已在回收站）
 * @returns {Object} { changes: number }
 */
function permanentlyDeleteMedias(imageIds) {
  if (!imageIds || imageIds.length === 0) return { changes: 0 };
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    DELETE FROM media
    WHERE deleted_at IS NOT NULL
      AND id IN (${placeholders})
  `);
  return stmt.run(...imageIds);
}

/**
 * 清空用户的回收站（物理删除所有已删除图片）
 * @param {number} userId - 用户ID
 * @returns {Object} { changes: number }
 */
function clearTrash(userId) {
  const stmt = db.prepare(`
    DELETE FROM media
    WHERE user_id = ?
      AND deleted_at IS NOT NULL
  `);
  return stmt.run(userId);
}

/**
 * 获取需要删除文件的图片信息（用于物理删除文件）
 * @param {number} userId - 用户ID
 * @param {Array<number>} imageIds - 图片ID数组
 * @returns {Array} 图片信息数组，包含存储键和存储类型
 */
/**
 * 获取需要删除文件的图片信息（仅回收站内 deleted_at IS NOT NULL）
 * @param {number} userId - 用户ID
 * @param {Array<number>} imageIds - 图片ID数组
 * @returns {Array} 图片信息数组
 */
function selectMediasForFileDeletion(userId, imageIds) {
  if (!imageIds || imageIds.length === 0) return [];
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT 
      id,
      user_id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NOT NULL
      AND id IN (${placeholders})
  `);
  return stmt.all(userId, ...imageIds);
}

/**
 * 获取清空回收站时需要删除文件的图片信息
 * @param {number} userId - 用户ID
 * @returns {Array} 图片信息数组
 */
function selectTrashMediasForFileDeletion(userId) {
  const stmt = db.prepare(`
    SELECT 
      id,
      user_id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NOT NULL
  `);
  return stmt.all(userId);
}

module.exports = {
  selectDeletedMediasByPage,
  selectDeletedMediasByIds,
  restoreMedias,
  permanentlyDeleteMedias,
  clearTrash,
  selectMediasForFileDeletion,
  selectTrashMediasForFileDeletion,
};
