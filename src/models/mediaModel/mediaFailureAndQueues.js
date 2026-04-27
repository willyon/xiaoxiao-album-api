/**
 * 媒体失败与补跑队列模型：负责失败列表、阶段统计、云 caption/map regeo 待补跑批次与校验查询。
 */
const { db } = require("../../db");

/**
 * 按阶段分页列出失败媒体。
 * @param {{userId:number,stage:"ingest"|"primary"|"cloud",mediaIds?:number[]|null,limit?:number,offset?:number}} params 查询参数
 * @returns {Array<Object>} 失败媒体列表
 */
function listFailedMedias({ userId, stage, mediaIds = null, limit = 500, offset = 0 }) {
  if (!userId) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const safeOffset = Math.max(0, Number(offset) || 0);

  let whereStage = "";
  if (stage === "ingest") {
    whereStage = "meta_pipeline_status = 'failed'";
  } else if (stage === "primary") {
    whereStage = "analysis_status_primary = 'failed'";
  } else if (stage === "cloud") {
    whereStage = "analysis_status_cloud = 'failed'";
  } else {
    return [];
  }

  const baseSql = `
    SELECT
      id              AS mediaId,
      file_size_bytes AS fileSize,
      media_type      AS mediaType,
      created_at      AS createdAt,
      original_storage_key AS originalStorageKey,
      file_hash       AS imageHash
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND ${whereStage}
  `;

  let sql = `${baseSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const params = [userId];

  if (Array.isArray(mediaIds) && mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => "?").join(", ");
    sql = `
      ${baseSql}
        AND id IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    mediaIds.forEach((id) => params.push(Number(id)));
  }

  params.push(safeLimit, safeOffset);
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    mediaId: row.mediaId,
    fileSize: row.fileSize,
    mediaType: row.mediaType || "image",
    createdAt: row.createdAt,
    originalStorageKey: row.originalStorageKey,
    imageHash: row.imageHash,
  }));
}

/**
 * 一次性拉取云阶段失败媒体（用于重试准备）。
 * @param {{userId:number,mediaIds?:number[]|null,maxRows?:number}} params 查询参数
 * @returns {Array<Object>} 失败媒体列表
 */
function listAllFailedCloudMedias({ userId, mediaIds = null, maxRows = 20000 }) {
  if (!userId) return [];
  const cap = Math.max(1, Math.min(Number(maxRows) || 20000, 200000));

  const baseSql = `
    SELECT
      id              AS mediaId,
      file_size_bytes AS fileSize,
      media_type      AS mediaType,
      created_at      AS createdAt,
      original_storage_key AS originalStorageKey,
      file_hash       AS imageHash
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND analysis_status_cloud = 'failed'
  `;
  const params = [userId];
  let sql = `${baseSql} ORDER BY created_at DESC LIMIT ?`;
  if (Array.isArray(mediaIds) && mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => "?").join(", ");
    sql = `
      ${baseSql}
        AND id IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ?
    `;
    mediaIds.forEach((id) => params.push(Number(id)));
  }
  params.push(cap);

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    mediaId: row.mediaId,
    fileSize: row.fileSize,
    mediaType: row.mediaType || "image",
    createdAt: row.createdAt,
    originalStorageKey: row.originalStorageKey,
    imageHash: row.imageHash,
  }));
}

/**
 * 统计各阶段失败条数。
 * @param {number} userId 用户 ID
 * @param {{includeCloudFailures?:boolean}} [options] 是否统计 cloud 失败
 * @returns {{ingest:number,primary:number,cloud:number,total:number}} 统计结果
 */
function countFailedMediasByStage(userId, options = {}) {
  const includeCloudFailures = options.includeCloudFailures !== false;
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid < 1) {
    return { ingest: 0, primary: 0, cloud: 0, total: 0 };
  }
  const cloudSelect = includeCloudFailures
    ? `COALESCE(SUM(CASE WHEN analysis_status_cloud = 'failed' THEN 1 ELSE 0 END), 0) AS cnt_cloud`
    : `0 AS cnt_cloud`;
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(CASE WHEN meta_pipeline_status = 'failed' THEN 1 ELSE 0 END), 0)       AS cnt_ingest,
        COALESCE(SUM(CASE WHEN analysis_status_primary = 'failed' THEN 1 ELSE 0 END), 0) AS cnt_primary,
        ${cloudSelect}
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
    `,
    )
    .get(uid);
  const ingest = Number(row?.cnt_ingest || 0);
  const primary = Number(row?.cnt_primary || 0);
  const cloud = includeCloudFailures ? Number(row?.cnt_cloud || 0) : 0;
  return { ingest, primary, cloud, total: ingest + primary + cloud };
}

/**
 * 按游标获取待补跑云 caption 批次（skipped）。
 * @param {number} limit 批大小
 * @param {number} userId 用户 ID
 * @param {number|null} [cursorBeforeId=null] 游标（取更小 ID）
 * @returns {Array<Object>} 待补跑行
 */
function selectPendingCloudCaptionBatch(limit, userId, cursorBeforeId = null) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid < 1) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const cursor = cursorBeforeId != null && Number.isFinite(Number(cursorBeforeId)) ? Number(cursorBeforeId) : null;
  if (cursor != null) {
    return db
      .prepare(
        `
    SELECT
      id   AS mediaId,
      user_id AS userId,
      high_res_storage_key AS highResStorageKey,
      original_storage_key AS originalStorageKey,
      media_type AS mediaType
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND analysis_status_cloud = 'skipped'
      AND id < ?
    ORDER BY id DESC
    LIMIT ?
  `,
      )
      .all(uid, cursor, safeLimit);
  }
  return db
    .prepare(
      `
    SELECT
      id   AS mediaId,
      user_id AS userId,
      high_res_storage_key AS highResStorageKey,
      original_storage_key AS originalStorageKey,
      media_type AS mediaType
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND analysis_status_cloud = 'skipped'
    ORDER BY id DESC
    LIMIT ?
  `,
    )
    .all(uid, safeLimit);
}

/**
 * 统计云阶段 skipped 媒体数量。
 * @param {number} userId 用户 ID
 * @returns {number} 条数
 */
function countCloudAnalysisSkippedForUser(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid < 1) return 0;
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND analysis_status_cloud = 'skipped'
    `,
    )
    .get(uid);
  return Number(row?.cnt || 0);
}

/**
 * 统计 map_regeo skipped/failed 且含 GPS 的媒体数量。
 * @param {number} userId 用户 ID
 * @returns {number} 条数
 */
function countMapRegeoSkippedForUser(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid < 1) return 0;
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND map_regeo_status IN ('skipped', 'failed')
        AND gps_latitude IS NOT NULL
        AND gps_longitude IS NOT NULL
    `,
    )
    .get(uid);
  return Number(row?.cnt || 0);
}

/**
 * 按游标获取待补跑 map regeo 批次。
 * @param {number} limit 批大小
 * @param {number} userId 用户 ID
 * @param {number|null} [cursorBeforeId=null] 游标（取更小 ID）
 * @returns {Array<Object>} 待补跑行
 */
function selectPendingMapRegeoBatch(limit, userId, cursorBeforeId = null) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid < 1) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const cursor = cursorBeforeId != null && Number.isFinite(Number(cursorBeforeId)) ? Number(cursorBeforeId) : null;
  const baseWhere = `
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND map_regeo_status IN ('skipped', 'failed')
      AND gps_latitude IS NOT NULL
      AND gps_longitude IS NOT NULL
  `;
  if (cursor != null) {
    return db
      .prepare(
        `
    SELECT
      id AS mediaId,
      user_id AS userId,
      gps_latitude AS latitude,
      gps_longitude AS longitude
    FROM media
    ${baseWhere}
      AND id < ?
    ORDER BY id DESC
    LIMIT ?
  `,
      )
      .all(uid, cursor, safeLimit);
  }
  return db
    .prepare(
      `
    SELECT
      id AS mediaId,
      user_id AS userId,
      gps_latitude AS latitude,
      gps_longitude AS longitude
    FROM media
    ${baseWhere}
    ORDER BY id DESC
    LIMIT ?
  `,
    )
    .all(uid, safeLimit);
}

/**
 * Worker 执行前校验媒体归属与存在性。
 * @param {number} mediaId 媒体 ID
 * @param {number} userId 用户 ID
 * @returns {{id:number,user_id:number,gps_latitude:number|null,gps_longitude:number|null,map_regeo_status:string}|null} 媒体行
 */
function selectMediaRowForMapRegeoJob(mediaId, userId) {
  const mid = Number(mediaId);
  const uid = Number(userId);
  if (!Number.isFinite(mid) || mid < 1 || !Number.isFinite(uid) || uid < 1) return null;
  return db
    .prepare(
      `
    SELECT id, user_id, gps_latitude, gps_longitude, map_regeo_status
    FROM media
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `,
    )
    .get(mid, uid);
}

module.exports = {
  listFailedMedias,
  listAllFailedCloudMedias,
  countFailedMediasByStage,
  selectPendingCloudCaptionBatch,
  countCloudAnalysisSkippedForUser,
  countMapRegeoSkippedForUser,
  selectPendingMapRegeoBatch,
  selectMediaRowForMapRegeoJob,
};
