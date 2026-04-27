/**
 * 媒体入库与去重查询：负责初始插入、按用户 hash 列表与按 hash 单行预检。
 */
const { db } = require("../../db");

/**
 * 插入一条媒体基础记录（幂等：相同哈希会被忽略）。
 * @param {{userId:number,imageHash:string,thumbnailStorageKey?:string,fileSizeBytes?:number,mediaType?:string,originalStorageKey?:string}} params 入参
 * @returns {{affectedRows:number}} 受影响行数
 */
function insertMedia({ userId, imageHash, thumbnailStorageKey, fileSizeBytes, mediaType, originalStorageKey }) {
  const now = Date.now();
  const normalizedType = mediaType === "video" ? "video" : "image";
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO media (
      user_id,
      file_hash,
      created_at,
      thumbnail_storage_key,
      file_size_bytes,
      media_type,
      original_storage_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(userId, imageHash, now, thumbnailStorageKey || null, fileSizeBytes || null, normalizedType, originalStorageKey || null);
  return { affectedRows: result.changes };
}

/**
 * 获取用户全部未删除媒体的文件哈希。
 * @param {number} userId 用户 ID
 * @returns {string[]} hash 列表
 */
function selectHashesByUserId(userId) {
  const stmt = db.prepare(`SELECT file_hash FROM media WHERE user_id = ? AND deleted_at IS NULL`).pluck();
  return stmt.all(userId);
}

/**
 * 通过用户与文件哈希查询单行（含软删记录）。
 * @param {{userId:number,imageHash:string}} params 查询参数
 * @returns {{id:number,deleted_at:number|null}|undefined} 命中行
 */
function selectMediaRowByHashForUser({ userId, imageHash }) {
  const stmt = db.prepare(`
    SELECT id, deleted_at
    FROM media
    WHERE user_id = ? AND file_hash = ?
    LIMIT 1
  `);
  return stmt.get(userId, imageHash);
}

module.exports = {
  insertMedia,
  selectHashesByUserId,
  selectMediaRowByHashForUser,
};
