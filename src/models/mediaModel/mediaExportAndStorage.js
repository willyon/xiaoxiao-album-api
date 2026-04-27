/**
 * 媒体导出与存储键查询模型：负责单条/批量导出所需存储键与媒体类型读取。
 */
const { db } = require('../../db')

/**
 * 查询单条媒体存储键信息。
 * @param {number} mediaId 媒体 ID
 * @returns {{id:number,thumbnailStorageKey:string|null,highResStorageKey:string|null,originalStorageKey:string|null,mediaType:string}|null} 存储信息
 */
function getMediaStorageInfo(mediaId) {
  const sql = `
    SELECT
      id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key,
      media_type
    FROM media
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `

  const stmt = db.prepare(sql)
  const image = stmt.get(mediaId)
  if (!image) return null

  return {
    id: image.id,
    thumbnailStorageKey: image.thumbnail_storage_key,
    highResStorageKey: image.high_res_storage_key,
    originalStorageKey: image.original_storage_key,
    mediaType: image.media_type || 'image'
  }
}

/**
 * 查询单条媒体导出所需存储键信息。
 * @param {{userId:number,mediaId:number}} params 查询参数
 * @returns {{id:number,mediaType:string,originalStorageKey:string|null,highResStorageKey:string|null,thumbnailStorageKey:string|null}|null} 导出用信息
 */
function getMediaExportInfo({ userId, mediaId }) {
  const sql = `
    SELECT
      id,
      media_type,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key
    FROM media
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `

  const stmt = db.prepare(sql)
  const image = stmt.get(mediaId, userId)
  if (!image) return null

  return {
    id: image.id,
    mediaType: image.media_type || 'image',
    originalStorageKey: image.original_storage_key,
    highResStorageKey: image.high_res_storage_key,
    thumbnailStorageKey: image.thumbnail_storage_key
  }
}

/**
 * 批量查询媒体导出所需存储键。
 * @param {{userId:number,mediaIds:number[]}} params 查询参数
 * @returns {Array<{id:number,originalStorageKey:string|null,highResStorageKey:string|null,thumbnailStorageKey:string|null}>} 导出用信息列表
 */
function getMediasExportInfo({ userId, mediaIds }) {
  if (!mediaIds || mediaIds.length === 0) return []

  const placeholders = mediaIds.map(() => '?').join(',')
  const sql = `
    SELECT
      id,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key
    FROM media
    WHERE id IN (${placeholders}) AND user_id = ? AND deleted_at IS NULL
  `

  const stmt = db.prepare(sql)
  const images = stmt.all(...mediaIds, userId)

  return images.map((image) => ({
    id: image.id,
    originalStorageKey: image.original_storage_key,
    highResStorageKey: image.high_res_storage_key,
    thumbnailStorageKey: image.thumbnail_storage_key
  }))
}

module.exports = {
  getMediaStorageInfo,
  getMediaExportInfo,
  getMediasExportInfo
}
