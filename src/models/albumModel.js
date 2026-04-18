/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册数据模型
 */
const { db } = require("../db");

const { mapFields } = require("../utils/fieldMapper");

/**
 * 规范化可选相册 ID 参数（空值返回 null）。
 * @param {number|string|null|undefined} raw - 原始相册 ID。
 * @returns {number|null} 规范化后的相册 ID。
 */
function normalizeOptionalAlbumId(raw) {
  if (raw == null || raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * 创建相册
 * @param {{userId:number|string,name:string,description?:string|null}} params - 创建参数。
 * @returns {{albumId:number|bigint,affectedRows:number}} 创建结果。
 */
function createAlbum({ userId, name, description }) {
  const sql = `
    INSERT INTO albums (user_id, name, description, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const stmt = db.prepare(sql);
  const now = Date.now();
  const result = stmt.run(userId, name, description || null, now, now, now);

  return {
    albumId: result.lastInsertRowid,
    affectedRows: result.changes,
  };
}

/**
 * 获取用户的相册列表
 * @param {{userId:number|string,includeDeleted?:boolean,search?:string|null,excludeAlbumId?:number|string|null}} params - 查询参数。
 * @returns {Array<object>} 相册列表。
 */
function getAlbumsByUserId({ userId, includeDeleted = false, search = null, excludeAlbumId = null }) {
  let sql = `
    SELECT 
      id,
      name,
      description,
      cover_media_id,
      media_count,
      created_at,
      updated_at,
      last_used_at
    FROM albums
    WHERE user_id = ?
  `;

  const params = [userId];

  if (!includeDeleted) {
    sql += " AND deleted_at IS NULL";
  }

  if (search && search.trim()) {
    sql += " AND (name LIKE ? OR description LIKE ?)";
    const searchPattern = `%${search.trim()}%`;
    params.push(searchPattern, searchPattern);
  }

  const normalizedExcludeAlbumId = normalizeOptionalAlbumId(excludeAlbumId);
  if (normalizedExcludeAlbumId != null) {
    sql += " AND id != ?";
    params.push(normalizedExcludeAlbumId);
  }

  sql += " ORDER BY COALESCE(last_used_at, created_at) DESC";

  const stmt = db.prepare(sql);
  const albums = stmt.all(...params);

  const mapped = mapFields("albums", albums);
  return mapped;
}

/**
 * 获取最近使用的相册（创建时间与上次添加/删除图片时间取较晚者倒序，取前 limit 个）
 * excludeAlbumId 可选，排除指定相册（如当前相册）
 * @param {{userId:number|string,limit?:number,excludeAlbumId?:number|string|null}} params - 查询参数。
 * @returns {Array<object>} 最近相册列表。
 */
function getRecentAlbumsByUserId({ userId, limit = 8, excludeAlbumId = null }) {
  let sql = `
    SELECT 
      id,
      name,
      description,
      cover_media_id,
      media_count,
      created_at,
      updated_at,
      last_used_at
    FROM albums
    WHERE user_id = ? AND deleted_at IS NULL
  `;
  const params = [userId];
  const normalizedExcludeAlbumId = normalizeOptionalAlbumId(excludeAlbumId);
  if (normalizedExcludeAlbumId != null) {
    sql += " AND id != ?";
    params.push(normalizedExcludeAlbumId);
  }
  sql += " ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?";
  params.push(limit);
  const stmt = db.prepare(sql);
  const albums = stmt.all(...params);
  return mapFields("albums", albums);
}

/**
 * 获取用户相册总数（用于判断是否显示「选择其他相册」，与 getAlbumsByUserId 条件一致）
 * @param {{userId:number|string,excludeAlbumId?:number|string|null}} params - 统计参数。
 * @returns {number} 相册总数。
 */
function getAlbumsCountByUserId({ userId, excludeAlbumId = null }) {
  let sql = "SELECT COUNT(*) AS total FROM albums WHERE user_id = ? AND deleted_at IS NULL";
  const params = [userId];
  const normalizedExcludeAlbumId = normalizeOptionalAlbumId(excludeAlbumId);
  if (normalizedExcludeAlbumId != null) {
    sql += " AND id != ?";
    params.push(normalizedExcludeAlbumId);
  }
  const stmt = db.prepare(sql);
  const row = stmt.get(...params);
  return row ? row.total : 0;
}

/**
 * 获取相册详情
 * @param {{albumId:number|string,userId:number|string}} params - 查询参数。
 * @returns {object|null} 相册详情或 null。
 */
function getAlbumById({ albumId, userId }) {
  const sql = `
    SELECT 
      id,
      name,
      description,
      cover_media_id,
      media_count,
      created_at,
      updated_at,
      last_used_at
    FROM albums
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `;

  const stmt = db.prepare(sql);
  const album = stmt.get(albumId, userId);

  return album ? mapFields("albums", [album])[0] : null;
}

/**
 * 更新相册信息
 * @param {{albumId:number|string,userId:number|string,name?:string,description?:string,coverImageId?:number|string}} params - 更新参数。
 * @returns {{affectedRows:number}} 更新结果。
 */
function updateAlbum({ albumId, userId, name, description, coverImageId }) {
  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push("name = ?");
    params.push(name);
  }
  if (description !== undefined) {
    updates.push("description = ?");
    params.push(description);
  }
  if (coverImageId !== undefined) {
    updates.push("cover_media_id = ?");
    params.push(coverImageId);
  }

  if (updates.length === 0) {
    return { affectedRows: 0 };
  }

  updates.push("updated_at = ?");
  params.push(Date.now());
  params.push(albumId, userId);

  const sql = `
    UPDATE albums 
    SET ${updates.join(", ")}
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(...params);

  return { affectedRows: result.changes };
}

/**
 * 删除相册（物理删除相册记录，并删除与之关联的 album_media 关系）
 * 注意：不会删除 media 表中的任何媒体，只是移除了相册分类关系
 * @param {{albumId:number|string,userId:number|string}} params - 删除参数。
 * @returns {{affectedRows:number}} 删除结果。
 */
function deleteAlbum({ albumId, userId }) {
  // 先删除相册与图片的关联关系
  const deleteRelationsSql = `
    DELETE FROM album_media
    WHERE album_id = ?
  `;
  db.prepare(deleteRelationsSql).run(albumId);

  // 再删除相册本身（限定为当前用户）
  const deleteAlbumSql = `
    DELETE FROM albums
    WHERE id = ? AND user_id = ?
  `;
  const stmt = db.prepare(deleteAlbumSql);
  const result = stmt.run(albumId, userId);

  return { affectedRows: result.changes };
}

/**
 * 更新相册的「上次使用时间」（添加/删除图片时调用）
 * @param {number|string} albumId - 相册 ID。
 * @returns {void} 无返回值。
 */
function updateAlbumLastUsedAt(albumId) {
  const now = Date.now();
  db.prepare("UPDATE albums SET last_used_at = ? WHERE id = ?").run(now, albumId);
}

/**
 * 添加图片到相册
 * @param {{albumId:number|string,mediaIds:Array<number|string>}} params - 添加参数。
 * @returns {{addedCount:number,skippedCount:number}} 添加结果。
 */
function addMediasToAlbum({ albumId, mediaIds }) {
  const insertSql = `
    INSERT OR IGNORE INTO album_media (album_id, media_id, added_at)
    VALUES (?, ?, ?)
  `;
  const insertStmt = db.prepare(insertSql);

  const now = Date.now();
  let addedCount = 0;

  for (const mediaId of mediaIds) {
    const result = insertStmt.run(albumId, mediaId, now);
    if (result.changes > 0) {
      addedCount++;
    }
  }

  if (addedCount > 0) {
    refreshAlbumStats(albumId, { touchLastUsedAt: true });
  }

  return {
    addedCount,
    skippedCount: mediaIds.length - addedCount,
  };
}

/**
 * 从相册中移除图片
 * @param {{albumId:number|string,mediaIds:Array<number|string>}} params - 移除参数。
 * @returns {{affectedRows:number}} 删除结果。
 */
function removeMediasFromAlbum({ albumId, mediaIds }) {
  const deleteSql = `
    DELETE FROM album_media
    WHERE album_id = ? AND media_id IN (${mediaIds.map(() => "?").join(",")})
  `;

  const stmt = db.prepare(deleteSql);
  const result = stmt.run(albumId, ...mediaIds);

  if (result.changes > 0) {
    refreshAlbumStats(albumId, { touchLastUsedAt: true });
  }

  return { affectedRows: result.changes };
}

/**
 * 获取相册内全部图片的时间范围（用于展示「整个相册」时间范围）
 * @param {number|string} albumId - 相册 ID。
 * @returns {{ earliest: number, latest: number } | null} 毫秒时间戳，无图片时返回 null
 */
function getAlbumTimeRange(albumId) {
  const sql = `
    SELECT
      MIN(i.captured_at) AS earliest,
      MAX(i.captured_at) AS latest
    FROM album_media ai
    INNER JOIN media i ON ai.media_id = i.id
    WHERE ai.album_id = ? AND i.deleted_at IS NULL AND i.captured_at IS NOT NULL
  `;
  const row = db.prepare(sql).get(albumId);
  if (!row || row.earliest == null || row.latest == null) return null;
  return { earliest: row.earliest, latest: row.latest };
}

/**
 * 检查媒体是否在相册中
 * @param {{albumId:number|string,mediaId:number|string}} params - 查询参数。
 * @returns {boolean} 是否在相册中。
 */
function isMediaInAlbum({ albumId, mediaId }) {
  const sql = `
    SELECT 1
    FROM album_media
    WHERE album_id = ? AND media_id = ?
    LIMIT 1
  `;

  const stmt = db.prepare(sql);
  const result = stmt.get(albumId, mediaId);

  return !!result;
}

/**
 * 更新相册的图片数量（物化字段）
 * 注意：只统计未删除的图片（i.deleted_at IS NULL）
 * @param {number|string} albumId - 相册 ID。
 * @returns {void} 无返回值。
 */
function updateAlbumMediaCount(albumId) {
  const sql = `
    UPDATE albums
    SET media_count = (
      SELECT COUNT(*)
      FROM album_media ai
      INNER JOIN media i ON ai.media_id = i.id
      WHERE ai.album_id = ? AND i.deleted_at IS NULL
    ),
    updated_at = ?
    WHERE id = ?
  `;

  const stmt = db.prepare(sql);
  stmt.run(albumId, Date.now(), albumId);
}

/**
 * 更新相册封面（选择最新添加的媒体，排除音频）
 * @param {number|string} albumId - 相册 ID。
 * @returns {void} 无返回值。
 */
function updateAlbumCover(albumId) {
  const sql = `
    UPDATE albums
    SET cover_media_id = (
      SELECT ai.media_id
      FROM album_media ai
      INNER JOIN media i ON ai.media_id = i.id AND i.deleted_at IS NULL
      WHERE ai.album_id = ?
        AND (COALESCE(i.media_type, 'image') IN ('image', 'video'))
      ORDER BY ai.added_at DESC, ai.media_id DESC
      LIMIT 1
    )
    WHERE id = ?
  `;

  const stmt = db.prepare(sql);
  stmt.run(albumId, albumId);
}

/**
 * 设置相册封面图片
 * @param {{albumId:number|string,mediaId:number|string}} params - 设置参数。
 * @returns {{affectedRows:number}} 设置结果。
 */
function setAlbumCover({ albumId, mediaId }) {
  const exists = isMediaInAlbum({ albumId, mediaId });
  if (!exists) {
    return { affectedRows: 0 };
  }

  const sql = `
    UPDATE albums
    SET cover_media_id = ?,
        updated_at = ?
    WHERE id = ?
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(mediaId, Date.now(), albumId);

  return { affectedRows: result.changes };
}

/**
 * 获取相册的封面媒体ID
 * @param {number|string} albumId - 相册 ID。
 * @returns {number|null} 封面媒体 ID。
 */
function getAlbumCoverMediaId(albumId) {
  const sql = `
    SELECT cover_media_id
    FROM albums
    WHERE id = ?
  `;
  const stmt = db.prepare(sql);
  const result = stmt.get(albumId);
  return result ? result.cover_media_id : null;
}

/**
 * 切换媒体的喜欢状态（仅更新 media.is_favorite）
 * @param {{userId:number|string,mediaId:number|string,isFavorite:boolean}} params - 更新参数。
 * @returns {{mediaId:number|string,isFavorite:boolean,affectedRows:number}} 更新结果。
 */
function toggleFavoriteMedia({ userId, mediaId, isFavorite }) {
  const updateImageSql = `
    UPDATE media 
    SET is_favorite = ? 
    WHERE id = ? AND user_id = ?
  `;
  const result = db.prepare(updateImageSql).run(isFavorite ? 1 : 0, mediaId, userId);

  return {
    mediaId,
    isFavorite,
    affectedRows: result.changes,
  };
}

/**
 * 获取包含指定图片的所有相册ID（仅未删除的相册）
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {number[]} 相册 ID 列表。
 */
function getAlbumsContainingMedias(mediaIds) {
  if (!mediaIds || mediaIds.length === 0) return [];

  const placeholders = mediaIds.map(() => "?").join(", ");
  const sql = `
    SELECT DISTINCT ai.album_id
    FROM album_media ai
    INNER JOIN albums a ON ai.album_id = a.id
    WHERE ai.media_id IN (${placeholders})
      AND a.deleted_at IS NULL
  `;

  const stmt = db.prepare(sql);
  const results = stmt.all(...mediaIds);
  return results.map((row) => row.album_id);
}

/**
 * 批量更新相册的图片数量和封面（仅统计未删除的图片）
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {void} 无返回值。
 */
function updateAlbumsStatsForMedias(mediaIds) {
  if (!mediaIds || mediaIds.length === 0) return;

  // 获取包含这些图片的所有相册ID
  const albumIds = getAlbumsContainingMedias(mediaIds);
  if (albumIds.length === 0) return;

  // 批量更新每个相册的统计信息
  albumIds.forEach((albumId) => {
    refreshAlbumStats(albumId);
  });
}

/**
 * 刷新相册统计信息（图片数量、封面、更新时间，可选更新上次使用时间）。
 * @param {number|string} albumId - 相册 ID。
 * @param {{touchLastUsedAt?:boolean}} [options] - 刷新选项。
 * @returns {void} 无返回值。
 */
function refreshAlbumStats(albumId, { touchLastUsedAt = false } = {}) {
  updateAlbumMediaCount(albumId);
  updateAlbumCover(albumId);
  if (touchLastUsedAt) {
    updateAlbumLastUsedAt(albumId);
  }
}

module.exports = {
  createAlbum,
  getAlbumsByUserId,
  getRecentAlbumsByUserId,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  addMediasToAlbum,
  removeMediasFromAlbum,
  getAlbumTimeRange,
  isMediaInAlbum,
  toggleFavoriteMedia,
  setAlbumCover,
  updateAlbumMediaCount,
  updateAlbumCover,
  refreshAlbumStats,
  getAlbumsContainingMedias,
  updateAlbumsStatsForMedias,
  getAlbumCoverMediaId,
  getAlbumsCountByUserId,
};
