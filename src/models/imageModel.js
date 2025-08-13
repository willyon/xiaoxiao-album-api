/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-14 01:10:31
 * @Description: File description
 */
const { db } = require("../services/dbService");

//保存用户上传的图片元数据到数据库
function insertImage({
  userId,
  originalImageUrl,
  bigHighQualityImageUrl,
  bigLowQualityImageUrl,
  previewImageUrl,
  creationDate,
  hash,
  yearKey,
  monthKey,
}) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO images (
      user_id,
      originalImageUrl,
      bigHighQualityImageUrl,
      bigLowQualityImageUrl,
      previewImageUrl,
      creationDate,
      hash,
      yearKey,  
      monthKey 
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    userId,
    originalImageUrl,
    bigHighQualityImageUrl,
    bigLowQualityImageUrl,
    previewImageUrl,
    creationDate,
    hash,
    yearKey,
    monthKey,
  );
  return { affectedRows: result.changes };
}

// 获取用户所有图片hash
function selectHashesByUserId(userId) {
  // pluck() 会让返回值从对象([{hash:'123'}, {hash:'2323'}])变为单列值(取结果的第一列也就是这里的{hash:'123'})['123', '2323']，
  const stmt = db.prepare(`SELECT hash FROM images WHERE user_id = ?`).pluck();
  return stmt.all(userId);
}

//分页获取用户全部图片数据
function selectImagesByPage({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询
  const dataQuery = db.prepare(`
    SELECT originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate, monthKey, yearKey
    FROM images
    WHERE user_id = ?
    ORDER BY COALESCE(creationDate, 0) DESC, id DESC
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
    return { data, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户具体某年份的图片数据 —— 基于物化的 yearKey
function selectImagesByYear({ pageNo, pageSize, yearKey, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate, monthKey, yearKey
    FROM images
    WHERE user_id = ?
      AND yearKey = ?
    ORDER BY COALESCE(creationDate, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND yearKey = ?
  `);

  try {
    const data = dataQuery.all(userId, yearKey, pageSize, offset);
    const { total } = countQuery.get(userId, yearKey);
    return { data, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户具体某月份的图片数据 —— 基于物化的 monthKey
function selectImagesByMonth({ pageNo, pageSize, monthKey, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate, monthKey, yearKey
    FROM images
    WHERE user_id = ?
      AND monthKey = ?
    ORDER BY COALESCE(creationDate, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND monthKey = ?
  `);

  try {
    const data = dataQuery.all(userId, monthKey, pageSize, offset);
    const { total } = countQuery.get(userId, monthKey);
    return { data, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按月分组（YYYY-MM / 'unknown'）数据 —— 基于物化 monthKey
function selectGroupsByMonth({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH counts AS (
      SELECT monthKey, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
      GROUP BY monthKey
    ),
    latest AS (
      -- 为每个 monthKey 选最新一张（先按 creationDate DESC，再按 id DESC 保证稳定）
      SELECT m.monthKey, m.previewImageUrl, m.creationDate, m.id
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.monthKey = m.monthKey
          ORDER BY COALESCE(m2.creationDate, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.monthKey
    )
    SELECT
      latest.monthKey AS timeOfGroup,        -- 分组键（YYYY-MM / 'unknown'）
      latest.previewImageUrl AS latestImageUrl,
      latest.creationDate,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.monthKey = latest.monthKey
    ORDER BY
      CASE WHEN latest.monthKey = 'unknown' THEN 1 ELSE 0 END,
      latest.monthKey DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数：直接对 monthKey 去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT monthKey) AS groupCount
    FROM images
    WHERE user_id = ?;
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按年分组（YYYY / 'unknown'）数据 —— 基于物化 yearKey
function selectGroupsByYear({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH counts AS (
      SELECT yearKey, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
      GROUP BY yearKey
    ),
    latest AS (
      -- 为每个 yearKey 选最新一张（先按 creationDate DESC，再按 id DESC 保证稳定）
      SELECT m.yearKey, m.previewImageUrl, m.creationDate, m.id
      FROM images m
      WHERE m.user_id = ?
        AND m.id = (
          SELECT m2.id
          FROM images m2
          WHERE m2.user_id = m.user_id
            AND m2.yearKey  = m.yearKey
          ORDER BY COALESCE(m2.creationDate, 0) DESC, m2.id DESC
          LIMIT 1
        )
      GROUP BY m.yearKey
    )
    SELECT
      latest.yearKey  AS timeOfGroup,        -- 分组键（YYYY / 'unknown'）
      latest.previewImageUrl AS latestImageUrl,
      latest.creationDate,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.yearKey = latest.yearKey
    ORDER BY
      CASE WHEN latest.yearKey = 'unknown' THEN 1 ELSE 0 END,
      latest.yearKey DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数：直接对 yearKey 去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT yearKey) AS groupCount
    FROM images
    WHERE user_id = ?;
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data, total };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  insertImage,
  selectImagesByPage,
  selectImagesByYear,
  selectImagesByMonth,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectHashesByUserId,
};
