/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 15:07:05
 * @Description: File description
 */
const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");

//保存用户上传的图片元数据到数据库（初始上传时的必要字段）
function insertImage({ userId, imageHash, thumbnailStorageKey, storageType, fileSizeBytes }) {
  // 构建动态SQL，只插入有值的字段
  const fields = [];
  const values = [];
  const placeholders = [];

  // 必需字段
  fields.push("user_id", "image_hash", "created_at");
  values.push(userId, imageHash, Date.now());
  placeholders.push("?", "?", "?");

  // 初始上传时的必要字段
  if (thumbnailStorageKey != null) {
    fields.push("thumbnail_storage_key");
    values.push(thumbnailStorageKey);
    placeholders.push("?");
  }
  if (storageType != null) {
    fields.push("storage_type");
    values.push(storageType);
    placeholders.push("?");
  }
  if (fileSizeBytes != null) {
    fields.push("file_size_bytes");
    values.push(fileSizeBytes);
    placeholders.push("?");
  }

  const sql = `
    INSERT OR IGNORE INTO images (${fields.join(", ")})
    VALUES (${placeholders.join(", ")})
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(...values);
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
    SELECT high_res_storage_key, thumbnail_storage_key, image_created_at, date_key, day_key, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
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
    SELECT high_res_storage_key, thumbnail_storage_key, image_created_at, date_key, day_key, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
      AND year_key = ?
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
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
    SELECT high_res_storage_key, thumbnail_storage_key, image_created_at, date_key, day_key, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
      AND month_key = ?
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
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

// 分页获取用户具体某个日期的图片数据 —— 基于物化的 dateKey
function selectImagesByDate({ pageNo, pageSize, dateKey, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT high_res_storage_key, thumbnail_storage_key, image_created_at, date_key, day_key, month_key, year_key, storage_type, gps_location
    FROM images
    WHERE user_id = ?
      AND date_key = ?
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND date_key = ?
  `);

  try {
    const data = dataQuery.all(userId, dateKey, pageSize, offset);
    const { total } = countQuery.get(userId, dateKey);
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
      -- 为每个 month_key 选最新一张（先按 image_created_at DESC，再按 id DESC 保证稳定）
      SELECT m.month_key, m.thumbnail_storage_key, m.image_created_at, m.id, m.storage_type
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.month_key = m.month_key
          ORDER BY COALESCE(m2.image_created_at, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.month_key
    )
    SELECT
      latest.month_key,        -- 分组键（YYYY-MM / 'unknown'）
      latest.thumbnail_storage_key AS latestImagekey,
      latest.image_created_at,
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
      -- 为每个 year_key 选最新一张（先按 image_created_at DESC，再按 id DESC 保证稳定）
      SELECT m.year_key, m.thumbnail_storage_key, m.image_created_at, m.id, m.storage_type
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.year_key  = m.year_key
          ORDER BY COALESCE(m2.image_created_at, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.year_key
    )
    SELECT
      latest.year_key,        -- 分组键（YYYY / 'unknown'）
      latest.thumbnail_storage_key AS latestImagekey,
      latest.image_created_at,
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

// 分页获取用户按日期分组（YYYY-MM-DD / 'unknown'）数据 —— 基于物化 dateKey
function selectGroupsByDate({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH counts AS (
      SELECT date_key, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
      GROUP BY date_key
    ),
    latest AS (
      -- 为每个 date_key 选最新一张（先按 image_created_at DESC，再按 id DESC 保证稳定）
      SELECT m.date_key, m.thumbnail_storage_key, m.image_created_at, m.id, m.storage_type
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.date_key = m.date_key
          ORDER BY COALESCE(m2.image_created_at, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.date_key
    )
    SELECT
      latest.date_key,        -- 分组键（YYYY-MM-DD / 'unknown'）
      latest.thumbnail_storage_key AS latestImagekey,
      latest.image_created_at,
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.date_key = latest.date_key
    ORDER BY
      CASE WHEN latest.date_key = 'unknown' THEN 1 ELSE 0 END,
      latest.date_key DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数：直接对 date_key 去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT date_key) AS groupCount
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
  dateKey,
  dayKey,
  highResStorageKey,
  originalStorageKey,
  gpsLatitude,
  gpsLongitude,
  gpsAltitude,
  gpsLocation,
  country,
  city,
  widthPx,
  heightPx,
  aspectRatio,
  rawOrientation,
  layoutType,
  hdWidthPx,
  hdHeightPx,
  thumbWidthPx,
  thumbHeightPx,
  storageType,
  mime,
}) {
  const fields = [];
  const params = [];

  if (creationDate != null) {
    fields.push("image_created_at = ?");
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
  if (dateKey != null) {
    fields.push("date_key = ?");
    params.push(dateKey);
  }
  if (dayKey != null) {
    fields.push("day_key = ?");
    params.push(dayKey);
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
  if (country != null) {
    fields.push("country = ?");
    params.push(country);
  }
  if (city != null) {
    fields.push("city = ?");
    params.push(city);
  }

  // 图片尺寸和方向信息更新
  if (widthPx != null) {
    fields.push("width_px = ?");
    params.push(widthPx);
  }
  if (heightPx != null) {
    fields.push("height_px = ?");
    params.push(heightPx);
  }
  if (aspectRatio != null) {
    fields.push("aspect_ratio = ?");
    params.push(aspectRatio);
  }
  if (rawOrientation != null) {
    fields.push("raw_orientation = ?");
    params.push(rawOrientation);
  }
  if (layoutType != null) {
    fields.push("layout_type = ?");
    params.push(layoutType);
  }

  // 高清图和缩略图尺寸更新
  if (hdWidthPx != null) {
    fields.push("hd_width_px = ?");
    params.push(hdWidthPx);
  }
  if (hdHeightPx != null) {
    fields.push("hd_height_px = ?");
    params.push(hdHeightPx);
  }
  if (thumbWidthPx != null) {
    fields.push("thumb_width_px = ?");
    params.push(thumbWidthPx);
  }
  if (thumbHeightPx != null) {
    fields.push("thumb_height_px = ?");
    params.push(thumbHeightPx);
  }

  if (storageType != null) {
    fields.push("storage_type = ?");
    params.push(storageType);
  }
  if (mime != null) {
    fields.push("mime = ?");
    params.push(mime);
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
  selectImagesByDate,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectGroupsByDate,
  selectHashesByUserId,
  checkFileExists,
};
