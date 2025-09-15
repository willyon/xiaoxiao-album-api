/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 15:07:05
 * @Description: File description
 */
const { db } = require("../services/dbService");
const { mapFields } = require("../utils/fieldMapper");

//保存用户上传的图片元数据到数据库
function insertImage({
  userId,
  imageHash,
  originalStorageKey,
  highResStorageKey,
  thumbnailStorageKey,
  creationDate,
  yearKey,
  monthKey,
  gpsLatitude,
  gpsLongitude,
  gpsAltitude,
  gpsLocation,
  storageType, // 默认本地存储
  fileSize, // 文件大小（字节）
}) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO images (
      user_id,
      image_hash,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key,
      creation_date,
      year_key,  
      month_key,
      gps_latitude,
      gps_longitude,
      gps_altitude,
      gps_location,
      storage_type,
      file_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    userId,
    imageHash,
    originalStorageKey,
    highResStorageKey,
    thumbnailStorageKey,
    creationDate,
    yearKey,
    monthKey,
    gpsLatitude,
    gpsLongitude,
    gpsAltitude,
    gpsLocation,
    storageType,
    fileSize,
  );
  return { affectedRows: result.changes };
}

// 获取用户所有图片hash
function selectHashesByUserId(userId) {
  // pluck() 会让返回值从对象([{hash:'123'}, {hash:'2323'}])变为单列值(取结果的第一列也就是这里的{hash:'123'})['123', '2323']，
  const stmt = db.prepare(`SELECT image_hash FROM images WHERE user_id = ?`).pluck();
  return stmt.all(userId);
}

//分页获取用户全部图片数据
function selectImagesByPage({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询
  const dataQuery = db.prepare(`
    SELECT high_res_storage_key, thumbnail_storage_key, creation_date, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
    ORDER BY COALESCE(creation_date, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  // 总数统计（与分页查询保持相同过滤条件）
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
  `);

  try {
    const data = dataQuery.all(userId, pageSize, offset);
    const { total } = countQuery.get(userId);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户具体某年份的图片数据 —— 基于物化的 yearKey
function selectImagesByYear({ pageNo, pageSize, yearKey, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT high_res_storage_key, thumbnail_storage_key, creation_date, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
      AND year_key = ?
    ORDER BY COALESCE(creation_date, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND year_key = ?
  `);

  try {
    const data = dataQuery.all(userId, yearKey, pageSize, offset);
    const { total } = countQuery.get(userId, yearKey);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户具体某月份的图片数据 —— 基于物化的 monthKey
function selectImagesByMonth({ pageNo, pageSize, monthKey, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT high_res_storage_key, thumbnail_storage_key, creation_date, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
      AND month_key = ?
    ORDER BY COALESCE(creation_date, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND month_key = ?
  `);

  try {
    const data = dataQuery.all(userId, monthKey, pageSize, offset);
    const { total } = countQuery.get(userId, monthKey);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按月分组（YYYY-MM / 'unknown'）数据 —— 基于物化 monthKey
function selectGroupsByMonth({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH counts AS (
      SELECT month_key, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
      GROUP BY month_key
    ),
    latest AS (
      -- 为每个 month_key 选最新一张（先按 creation_date DESC，再按 id DESC 保证稳定）
      SELECT m.month_key, m.thumbnail_storage_key, m.creation_date, m.id, m.storage_type
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.month_key = m.month_key
          ORDER BY COALESCE(m2.creation_date, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.month_key
    )
    SELECT
      latest.month_key,        -- 分组键（YYYY-MM / 'unknown'）
      latest.thumbnail_storage_key AS latestImagekey,
      latest.creation_date,
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.month_key = latest.month_key
    ORDER BY
      CASE WHEN latest.month_key = 'unknown' THEN 1 ELSE 0 END,
      latest.month_key DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数：直接对 month_key 去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT month_key) AS groupCount
    FROM images
    WHERE user_id = ?;
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按年分组（YYYY / 'unknown'）数据 —— 基于物化 yearKey
function selectGroupsByYear({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH counts AS (
      SELECT year_key, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
      GROUP BY year_key
    ),
    latest AS (
      -- 为每个 year_key 选最新一张（先按 creation_date DESC，再按 id DESC 保证稳定）
      SELECT m.year_key, m.thumbnail_storage_key, m.creation_date, m.id, m.storage_type
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.year_key  = m.year_key
          ORDER BY COALESCE(m2.creation_date, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.year_key
    )
    SELECT
      latest.year_key,        -- 分组键（YYYY / 'unknown'）
      latest.thumbnail_storage_key AS latestImagekey,
      latest.creation_date,
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.year_key = latest.year_key
    ORDER BY
      CASE WHEN latest.year_key = 'unknown' THEN 1 ELSE 0 END,
      latest.year_key DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数：直接对 year_key 去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT year_key) AS groupCount
    FROM images
    WHERE user_id = ?;
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
  }
}
// 仅更新有值的字段
function updateMetaAndHQ({
  userId,
  imageHash,
  creationDate,
  monthKey,
  yearKey,
  highResStorageKey,
  originalStorageKey,
  gpsLatitude,
  gpsLongitude,
  gpsAltitude,
  gpsLocation,
  storageType,
}) {
  const fields = [];
  const params = [];

  if (creationDate != null) {
    fields.push("creation_date = ?");
    params.push(creationDate);
  }
  if (monthKey != null) {
    fields.push("month_key = ?");
    params.push(monthKey);
  }
  if (yearKey != null) {
    fields.push("year_key = ?");
    params.push(yearKey);
  }
  if (highResStorageKey != null) {
    fields.push("high_res_storage_key = ?");
    params.push(highResStorageKey);
  }
  if (originalStorageKey != null) {
    fields.push("original_storage_key = ?");
    params.push(originalStorageKey);
  }

  // GPS 信息更新
  if (gpsLatitude != null) {
    fields.push("gps_latitude = ?");
    params.push(gpsLatitude);
  }
  if (gpsLongitude != null) {
    fields.push("gps_longitude = ?");
    params.push(gpsLongitude);
  }
  if (gpsAltitude != null) {
    fields.push("gps_altitude = ?");
    params.push(gpsAltitude);
  }
  if (gpsLocation != null) {
    fields.push("gps_location = ?");
    params.push(gpsLocation);
  }
  if (storageType != null) {
    fields.push("storage_type = ?");
    params.push(storageType);
  }

  if (!fields.length) return { affectedRows: 0 };

  params.push(userId, imageHash);
  const sql = `UPDATE images SET ${fields.join(", ")} WHERE user_id = ? AND image_hash = ?`;
  return db.prepare(sql).run(...params);
}

// 检查文件是否已存在（用于预检）
function checkFileExists({ imageHash, userId }) {
  const stmt = db.prepare(`
    SELECT id
    FROM images 
    WHERE image_hash = ? AND user_id = ?
    LIMIT 1
  `);
  return stmt.get(imageHash, userId);
}

module.exports = {
  insertImage,
  updateMetaAndHQ,
  selectImagesByPage,
  selectImagesByYear,
  selectImagesByMonth,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectHashesByUserId,
  checkFileExists,
};
