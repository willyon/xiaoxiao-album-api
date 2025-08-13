/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 09:12:40
 * @Description: File description
 */
const { db } = require("../services/dbService");

//保存图片信息到数据库
function insertImage({ userId, originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate, hash }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO images (
      user_id,
      originalImageUrl,
      bigHighQualityImageUrl,
      bigLowQualityImageUrl,
      previewImageUrl,
      creationDate,
      hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(userId, originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate, hash);
  return { affectedRows: result.changes };
}

// 获取所有图片信息
function selectAllImages() {
  const stmt = db.prepare(`SELECT * FROM images`);
  return stmt.all();
}

// 根据userid获取所有图片hash
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
    SELECT originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate
    FROM images
    WHERE user_id = ?
    ORDER BY creationDate DESC
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

// 分页获取用户具体某个时间段(某月、某年)图片数据
function selectImagesByTimeRange({ pageNo, pageSize, creationDate, timeRange, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 如果传入 creationDate，则按年或月进行筛选
  if (creationDate) {
    const d = new Date(creationDate);
    const year = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, "0");

    // 选择 SQL 分组格式和匹配键
    const isMonth = timeRange === "month";
    const fmt = isMonth ? "%Y-%m" : "%Y";
    const key = isMonth ? `${year}-${month}` : year;

    const dataQuery = db.prepare(`
      SELECT originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate
      FROM images
      WHERE user_id = ?
        AND strftime('${fmt}', creationDate / 1000, 'unixepoch', 'localtime') = ?
      ORDER BY creationDate DESC
      LIMIT ? OFFSET ?
    `);

    const countQuery = db.prepare(`
      SELECT COUNT(*) AS total
      FROM images
      WHERE user_id = ?
        AND strftime('${fmt}', creationDate / 1000, 'unixepoch', 'localtime') = ?
    `);

    try {
      const pageData = dataQuery.all(userId, key, pageSize, offset);
      const total = countQuery.get(userId, key).total;
      return { data: pageData, total };
    } catch (error) {
      throw error;
    }
  }

  // 未提供 creationDate：返回无拍摄时间戳的记录
  const dataQuery = db.prepare(`
    SELECT originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, creationDate
    FROM images
    WHERE user_id = ? AND creationDate IS NULL
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ? AND creationDate IS NULL
  `);

  try {
    const pageData = dataQuery.all(userId, pageSize, offset);
    const total = countQuery.get(userId).total;
    return { data: pageData, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按月分组数据 性能最优版本 待测试 按月份分组（YYYY-MM / 'unknown'），并给每组挑出“最新一张图”
function selectGroupsByMonth({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH base AS (
      SELECT
        id, user_id, previewImageUrl, creationDate,
        CASE
          WHEN creationDate IS NULL THEN 'unknown'
          ELSE strftime('%Y-%m', creationDate/1000, 'unixepoch','localtime')
        END AS monthKey
      FROM images
      WHERE user_id = ?
    ),
    groups AS (
      SELECT
        monthKey AS timeOfGroup,
        COUNT(*) AS imageCount,
        /* 仅对非 unknown 组计算该月的起止毫秒边界 */
        CASE WHEN monthKey = 'unknown' THEN NULL
             ELSE CAST(strftime('%s', monthKey || '-01 00:00:00','localtime') AS INTEGER) * 1000
        END AS startMs,
        CASE WHEN monthKey = 'unknown' THEN NULL
             ELSE CAST(strftime('%s', date(monthKey || '-01','+1 month'),'localtime') AS INTEGER) * 1000
        END AS endMs
      FROM base
      GROUP BY monthKey
    )
    SELECT
      g.timeOfGroup,
      /* 该组里最新一张图的封面 */
      (
        SELECT i.previewImageUrl
        FROM images i
        WHERE i.user_id = ?
          AND (
            (g.timeOfGroup = 'unknown' AND i.creationDate IS NULL)
            OR (g.timeOfGroup <> 'unknown' AND i.creationDate >= g.startMs AND i.creationDate < g.endMs)
          )
        ORDER BY COALESCE(i.creationDate, 0) DESC, i.id DESC
        LIMIT 1
      ) AS latestImageUrl,
      /* 该组里“最新图”的 creationDate */
      (
        SELECT i.creationDate
        FROM images i
        WHERE i.user_id = ?
          AND (
            (g.timeOfGroup = 'unknown' AND i.creationDate IS NULL)
            OR (g.timeOfGroup <> 'unknown' AND i.creationDate >= g.startMs AND i.creationDate < g.endMs)
          )
        ORDER BY COALESCE(i.creationDate, 0) DESC, i.id DESC
        LIMIT 1
      ) AS creationDate,
      g.imageCount
    FROM groups g
    ORDER BY
      CASE WHEN g.timeOfGroup = 'unknown' THEN 1 ELSE 0 END,
      g.timeOfGroup DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数统计：对同一用户按 monthKey 分组后再 COUNT(*)
  const countQuery = db.prepare(`
      SELECT COUNT(
        DISTINCT CASE
          WHEN creationDate IS NULL THEN 'unknown'
          ELSE strftime('%Y-%m', creationDate/1000, 'unixepoch', 'localtime')
        END
      ) AS groupCount
      FROM images
      WHERE user_id = ?;
  `);

  try {
    // 参数顺序：userId(基表) → userId(子查询1) → userId(子查询2) → pageSize → offset
    const pageData = dataQuery.all(userId, userId, userId, pageSize, offset);

    const total = countQuery.get(userId).groupCount;

    return { data: pageData, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按月分组数据 性能最优版本 待测试
function selectGroupsByYear({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 数据 + 分组统计 + 取每组最新一张（不再用 strftime 相等比较）
  const dataQuery = db.prepare(`
    WITH base AS (
      SELECT
        id, user_id, previewImageUrl, creationDate,
        CASE
          WHEN creationDate IS NULL THEN 'unknown'
          ELSE strftime('%Y', creationDate/1000, 'unixepoch', 'localtime')
        END AS yearKey
      FROM images
      WHERE user_id = ?
    ),
    counts AS (
      SELECT yearKey, COUNT(*) AS imageCount
      FROM base
      GROUP BY yearKey
    ),
    latest AS (
      -- 为每个 yearKey 选出“最新的一张”：先按 creationDate DESC，再用 id DESC 稳定排序
      SELECT b.yearKey, b.previewImageUrl, b.creationDate, b.id
      FROM base b
      WHERE b.id = (
        SELECT b2.id
        FROM base b2
        WHERE b2.yearKey = b.yearKey
        ORDER BY COALESCE(b2.creationDate, 0) DESC, b2.id DESC
        LIMIT 1
      )
      GROUP BY b.yearKey
    )
    SELECT
      latest.yearKey AS timeOfGroup,
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

  // 组总数：按用户对“年份/unknown”去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(
      DISTINCT CASE
        WHEN creationDate IS NULL THEN 'unknown'
        ELSE strftime('%Y', creationDate/1000, 'unixepoch', 'localtime')
      END
    ) AS groupCount
    FROM images
    WHERE user_id = ?;
  `);

  try {
    const data = dataQuery.all(userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data, total };
  } catch (error) {
    throw error;
  }
}

// 分页获取按年份分组图片目录数据
//unixepoch表示把时间戳(秒)转为日期时间(这里是 年 )
// function _countGroupsByYear() {
//   const countQuery = db.prepare(`
//         SELECT COUNT(DISTINCT CASE
//           WHEN creationDate IS NULL THEN 'unknown'
//           ELSE strftime('%Y', creationDate / 1000, 'unixepoch', 'localtime')
//         END) AS groupCount
//         FROM images;
//       `);
//   try {
//     return countQuery.get().groupCount;
//   } catch (error) {
//     throw error;
//   }
// }
// 分页获取用户按年分组数据
// function selectGroupsByYear({ pageNo, pageSize, userId }) {
//   const offset = (pageNo - 1) * pageSize;
//   const dataQuery = db.prepare(`
//     SELECT
//       CASE
//         WHEN creationDate IS NULL THEN 'unknown'
//         ELSE strftime('%Y', creationDate / 1000, 'unixepoch', 'localtime')
//       END AS timeOfGroup,

//       (SELECT previewImageUrl FROM images AS i2
//         WHERE (strftime('%Y', i2.creationDate / 1000, 'unixepoch', 'localtime') = strftime('%Y', i1.creationDate / 1000, 'unixepoch', 'localtime')
//         OR (i2.creationDate IS NULL))
//       ORDER BY i2.creationDate DESC LIMIT 1
//       ) AS latestImageUrl,

//       (SELECT creationDate FROM images AS i2
//         WHERE (strftime('%Y', i2.creationDate / 1000, 'unixepoch', 'localtime') = strftime('%Y', i1.creationDate / 1000, 'unixepoch', 'localtime')
//         OR (i2.creationDate IS NULL))
//       ORDER BY i2.creationDate DESC LIMIT 1
//       ) AS creationDate,

//       COUNT(*) AS imageCount

//     FROM images AS i1
//     GROUP BY timeOfGroup
//     ORDER BY
//       CASE
//         WHEN timeOfGroup = 'unknown' THEN 1
//         ELSE 0
//       END,
//       timeOfGroup DESC
//     LIMIT ? OFFSET ?;
//   `);
//   try {
//     const pageData = dataQuery.all(pageSize, offset);
//     const total = _countGroupsByYear();
//     return {
//       data: pageData,
//       total,
//     };
//   } catch (error) {
//     throw error;
//   }
// }
// 分页获取按月份分组图片目录数据 — 统计组数（按用户）
// function _countGroupsByMonth(userId) {
//   const countQuery = db.prepare(`
//     SELECT COUNT(*) AS groupCount
//     FROM (
//       SELECT DISTINCT
//         CASE
//           WHEN creationDate IS NULL THEN 'unknown'
//           ELSE strftime('%Y-%m', creationDate / 1000, 'unixepoch', 'localtime')
//         END AS monthKey
//       FROM images
//       WHERE user_id = ?
//     ) t
//   `);
//   try {
//     return countQuery.get(userId).groupCount;
//   } catch (error) {
//     throw error;
//   }
// }

// 更新版本 次优 未测试
// function selectGroupsByMonth({ pageNo, pageSize, userId }) {
//   const offset = (pageNo - 1) * pageSize;

//   // 说明：
//   // 1) 外层按 user_id 过滤；
//   // 2) 分组键 timeOfGroup：无时间 -> 'unknown'，有时间 -> 'YYYY-MM'；
//   // 3) 子查询（latestImageUrl / creationDate）同样按 user_id 过滤，
//   //    且根据分组键区分：
//   //    - unknown 组：仅匹配 creationDate IS NULL
//   //    - 其它组：匹配同一个 YYYY-MM
//   // 4) 子查询排序用 COALESCE(creationDate, 0) DESC, id DESC，
//   //    既能在有时间的组取最新，也能在无时间的组用 id 兜底取最近插入的。
//   const dataQuery = db.prepare(`
//     SELECT
//       CASE
//         WHEN i1.creationDate IS NULL THEN 'unknown'
//         ELSE strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch', 'localtime')
//       END AS timeOfGroup,

//       (
//         SELECT i2.previewImageUrl
//         FROM images AS i2
//         WHERE i2.user_id = ?
//           AND (
//             (i1.creationDate IS NULL AND i2.creationDate IS NULL)
//             OR
//             (i1.creationDate IS NOT NULL AND i2.creationDate IS NOT NULL AND
//               strftime('%Y-%m', i2.creationDate / 1000, 'unixepoch', 'localtime')
//               = strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch', 'localtime')
//             )
//           )
//         ORDER BY COALESCE(i2.creationDate, 0) DESC, i2.id DESC
//         LIMIT 1
//       ) AS latestImageUrl,

//       (
//         SELECT i2.creationDate
//         FROM images AS i2
//         WHERE i2.user_id = ?
//           AND (
//             (i1.creationDate IS NULL AND i2.creationDate IS NULL)
//             OR
//             (i1.creationDate IS NOT NULL AND i2.creationDate IS NOT NULL AND
//               strftime('%Y-%m', i2.creationDate / 1000, 'unixepoch', 'localtime')
//               = strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch', 'localtime')
//             )
//           )
//         ORDER BY COALESCE(i2.creationDate, 0) DESC, i2.id DESC
//         LIMIT 1
//       ) AS creationDate,

//       COUNT(*) AS imageCount

//     FROM images AS i1
//     WHERE i1.user_id = ?
//     GROUP BY timeOfGroup
//     ORDER BY
//       CASE WHEN timeOfGroup = 'unknown' THEN 1 ELSE 0 END,
//       timeOfGroup DESC
//     LIMIT ? OFFSET ?;
//   `);

//   try {
//     // 注意参数顺序：子查询 user_id 两次 + 外层 WHERE 的 user_id + 分页参数
//     const pageData = dataQuery.all(userId, userId, userId, pageSize, offset);
//     const total = _countGroupsByMonth(userId);
//     return { data: pageData, total };
//   } catch (error) {
//     throw error;
//   }
// }

// function selectGroupsByMonth({ pageNo, pageSize, userId }) {
//   const offset = (pageNo - 1) * pageSize;
//   const dataQuery = db.prepare(`
//     SELECT
//       CASE
//         WHEN creationDate IS NULL THEN 'unknown'
//         ELSE strftime('%Y-%m', creationDate / 1000, 'unixepoch', 'localtime')
//       END AS timeOfGroup,

//       (SELECT previewImageUrl FROM images AS i2
//       WHERE (strftime('%Y-%m', i2.creationDate / 1000, 'unixepoch', 'localtime') = strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch', 'localtime')
//         OR (i2.creationDate IS NULL))
//       ORDER BY i2.creationDate DESC LIMIT 1
//       ) AS latestImageUrl,

//       (SELECT creationDate FROM images AS i2
//       WHERE (strftime('%Y-%m', i2.creationDate / 1000, 'unixepoch', 'localtime') = strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch', 'localtime')
//         OR (i2.creationDate IS NULL))
//       ORDER BY i2.creationDate DESC LIMIT 1
//       ) AS creationDate,

//       COUNT(*) AS imageCount

//     FROM images AS i1
//     GROUP BY timeOfGroup
//     ORDER BY
//       CASE
//         WHEN timeOfGroup = 'unknown' THEN 1
//         ELSE 0
//       END,
//       timeOfGroup DESC
//     LIMIT ? OFFSET ?;
//   `);
//   try {
//     const pageData = dataQuery.all(pageSize, offset);
//     const total = _countGroupsByMonth();
//     return {
//       data: pageData,
//       total,
//     };
//   } catch (error) {
//     throw error;
//   }
// }

module.exports = {
  insertImage,
  selectAllImages,
  selectImagesByPage,
  selectImagesByTimeRange,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectHashesByUserId,
};
