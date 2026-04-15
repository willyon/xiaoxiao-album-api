/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 自然语言搜索功能和算法
 */

const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");
const { sqlLocationKeyNullable } = require("./mediaModel");

const LOC_KEY_MEDIA = sqlLocationKeyNullable("media");

function normalizeSearchRows(rows) {
  return mapFields("media", rows);
}

/**
 * 列出媒体搜索结果（支持复杂筛选条件）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @param {number} params.limit - 返回结果数量
 * @param {number} params.offset - 偏移量
 * @returns {Array} 搜索结果
 */
function listMediaSearchResults({ userId, ftsQuery, whereConditions = [], whereParams = [], limit = 50, offset = 0 }) {
  let sql;
  let params;

  if (ftsQuery) {
    // 使用 FTS 查询
    sql = `
      SELECT 
        i.id,
        i.thumbnail_storage_key,
        i.high_res_storage_key,
        i.original_storage_key,
        i.media_type,
        i.duration_sec,
        i.captured_at,
        i.date_key,
        i.month_key,
        i.day_key,
        i.gps_location,
        i.width_px,
        i.height_px,
        i.aspect_ratio,
        i.layout_type,
        i.file_size_bytes,
        COALESCE(i.face_count, 0) AS face_count,
        COALESCE(i.person_count, 0) AS person_count,
        i.ai_description,
        i.ai_ocr,
        NULL AS age_tags,
        i.expression_tags AS expression_tags,
        i.is_favorite
      FROM media_search_fts fts
      JOIN media_search ms ON fts.rowid = ms.media_id
      JOIN media i ON ms.media_id = i.id
      WHERE i.user_id = ? 
        AND i.deleted_at IS NULL
        AND media_search_fts MATCH ?
    `;

    // 添加额外的 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += `
      ORDER BY fts.rank ASC, i.captured_at DESC
      LIMIT ? OFFSET ?
    `;

    params = [userId, ftsQuery, ...whereParams, limit, offset];
  } else {
    // 不使用 FTS，直接查询 media 表（用于纯筛选或查询所有媒体）
    sql = `
      SELECT 
        i.id,
        i.thumbnail_storage_key,
        i.high_res_storage_key,
        i.original_storage_key,
        i.media_type,
        i.duration_sec,
        i.captured_at,
        i.date_key,
        i.month_key,
        i.day_key,
        i.gps_location,
        i.width_px,
        i.height_px,
        i.aspect_ratio,
        i.layout_type,
        i.file_size_bytes,
        COALESCE(i.face_count, 0) AS face_count,
        COALESCE(i.person_count, 0) AS person_count,
        i.ai_description,
        i.ai_ocr,
        NULL AS age_tags,
        i.expression_tags AS expression_tags,
        i.is_favorite
      FROM media i
      WHERE i.user_id = ?
        AND i.deleted_at IS NULL
    `;

    // 添加 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += `
      ORDER BY i.captured_at DESC
      LIMIT ? OFFSET ?
    `;

    params = [userId, ...whereParams, limit, offset];
  }

  const stmt = db.prepare(sql);
  const results = stmt.all(...params);
  return normalizeSearchRows(results);
}

/**
 * 统计媒体搜索结果总数
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @returns {number} 总记录数
 */
function countMediaSearchResults({ userId, ftsQuery, whereConditions = [], whereParams = [] }) {
  let sql;
  let params;

  if (ftsQuery) {
    // 使用 FTS 查询计数
    sql = `
      SELECT COUNT(*) as total
      FROM media_search_fts fts
      JOIN media_search ms ON fts.rowid = ms.media_id
      JOIN media i ON ms.media_id = i.id
      WHERE i.user_id = ? 
        AND i.deleted_at IS NULL
        AND media_search_fts MATCH ?
    `;

    // 添加额外的 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    params = [userId, ftsQuery, ...whereParams];
  } else {
    // 直接查询 media 表计数
    sql = `
      SELECT COUNT(*) as total
      FROM media i
      WHERE i.user_id = ?
        AND i.deleted_at IS NULL
    `;

    // 添加 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    params = [userId, ...whereParams];
  }

  const stmt = db.prepare(sql);
  const result = stmt.get(...params);
  return result ? result.total : 0;
}

function recallMediaIdsByFts({ userId, ftsQuery, whereConditions = [], whereParams = [], limit } = {}) {
  if (!ftsQuery) {
    return [];
  }

  let sql = `
    SELECT
      i.id AS media_id,
      bm25(media_search_fts, 6.0, 7.0, 11.0, 12.0, 9.0, 3.0, 14.0) AS fts_score,
      i.captured_at
    FROM media_search_fts fts
    JOIN media_search ms ON fts.rowid = ms.media_id
    JOIN media i ON ms.media_id = i.id
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND media_search_fts MATCH ?
  `;

  if (whereConditions.length > 0) {
    sql += " AND " + whereConditions.join(" AND ");
  }

  sql += `
    ORDER BY fts_score ASC, i.captured_at DESC
  `;

  const params = [userId, ftsQuery, ...whereParams];
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

/**
 * 仅按筛选 WHERE 召回媒体 id（无 FTS），用于分段搜索中「只剩结构化条件」的路径。
 */
function recallMediaIdsByFiltersOnly({ userId, whereConditions = [], whereParams = [], limit = 200000 } = {}) {
  let sql = `
    SELECT
      i.id AS media_id,
      i.captured_at
    FROM media i
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
  `;

  if (whereConditions.length > 0) {
    sql += " AND " + whereConditions.join(" AND ");
  }

  sql += `
    ORDER BY i.captured_at DESC
  `;

  const params = [userId, ...whereParams];
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

/**
 * OCR：整句子串匹配 media_search.ocr_text（LOWER + LIKE，pattern 已含 % 且对 %_\\ 做过 ESCAPE）。
 */
function recallMediaIdsByOcrTextLike({ userId, likePattern, whereConditions = [], whereParams = [], limit } = {}) {
  if (!likePattern || typeof likePattern !== "string") {
    return [];
  }

  let sql = `
    SELECT
      i.id AS media_id,
      i.captured_at
    FROM media_search ms
    JOIN media i ON ms.media_id = i.id
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND ms.ocr_text IS NOT NULL
      AND TRIM(ms.ocr_text) != ''
      AND LOWER(ms.ocr_text) LIKE ? ESCAPE '\\'
  `;

  if (whereConditions.length > 0) {
    sql += " AND " + whereConditions.join(" AND ");
  }

  sql += `
    ORDER BY i.captured_at DESC
  `;

  const params = [userId, likePattern, ...whereParams];
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

function recallMediaIdsByChineseTerms({
  userId,
  terms = [],
  whereConditions = [],
  whereParams = [],
  limit,
  fieldTypes,
} = {}) {
  if (!Array.isArray(terms) || terms.length === 0) {
    return [];
  }

  const placeholders = terms.map(() => "?").join(",");
  let sql = `
    SELECT
      mst.media_id,
      mst.field_type,
      mst.term,
      mst.term_len,
      i.captured_at
    FROM media_search_terms mst
    JOIN media i ON i.id = mst.media_id
    WHERE mst.user_id = ?
      AND i.deleted_at IS NULL
      AND mst.term IN (${placeholders})
  `;

  if (Array.isArray(fieldTypes) && fieldTypes.length > 0) {
    const ftPh = fieldTypes.map(() => "?").join(",");
    sql += ` AND mst.field_type IN (${ftPh})`;
  }

  if (whereConditions.length > 0) {
    sql += " AND " + whereConditions.join(" AND ");
  }

  sql += `
    ORDER BY mst.term_len DESC, i.captured_at DESC
  `;

  const params = [userId, ...terms];
  if (Array.isArray(fieldTypes) && fieldTypes.length > 0) {
    params.push(...fieldTypes);
  }
  params.push(...whereParams);
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

function countMediaIdsByChineseTerms({ userId, terms = [], whereConditions = [], whereParams = [] }) {
  if (!Array.isArray(terms) || terms.length === 0) {
    return 0;
  }

  const placeholders = terms.map(() => "?").join(",");
  let sql = `
    SELECT COUNT(DISTINCT mst.media_id) AS total
    FROM media_search_terms mst
    JOIN media i ON i.id = mst.media_id
    WHERE mst.user_id = ?
      AND i.deleted_at IS NULL
      AND mst.term IN (${placeholders})
  `;

  if (whereConditions.length > 0) {
    sql += " AND " + whereConditions.join(" AND ");
  }

  const row = db.prepare(sql).get(userId, ...terms, ...whereParams);
  return row ? row.total : 0;
}

/**
 * 根据图片 ID 列表获取图片信息
 * @param {number} userId - 用户ID
 * @param {Array<number>} imageIds - 图片ID列表
 * @returns {Array} 图片信息列表
 */
function getMediasByIds({ userId, imageIds }) {
  if (!imageIds || imageIds.length === 0) {
    return [];
  }

  const placeholders = imageIds.map(() => "?").join(",");
  const sql = `
    SELECT 
      i.id,
      i.thumbnail_storage_key,
      i.high_res_storage_key,
      i.original_storage_key,
      i.media_type,
      i.duration_sec,
      i.captured_at,
      i.date_key,
      i.month_key,
      i.day_key,
      i.gps_location,
      i.width_px,
      i.height_px,
      i.aspect_ratio,
      i.layout_type,
      i.file_size_bytes,
      COALESCE(i.face_count, 0) AS face_count,
      COALESCE(i.person_count, 0) AS person_count,
      i.ai_description,
      i.ai_ocr,
      NULL AS age_tags,
      i.expression_tags AS expression_tags,
      i.is_favorite
    FROM media i
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND i.id IN (${placeholders})
    ORDER BY i.captured_at DESC
  `;

  const stmt = db.prepare(sql);
  const results = stmt.all(userId, ...imageIds);
  return normalizeSearchRows(results);
}

/**
 * 分页获取筛选选项列表（支持 scope：在当前维度下的选项）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.type - 选项类型: 'city' | 'year' | 'month' | 'weekday'
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量（默认20）
 * @param {string|null} [params.mediaType] - 媒体类型：'image' | 'video'，null 或 'all' 表示不过滤
 * @param {string[]} [params.scopeConditions] - 范围条件（表别名 i.，内部会转为 images.）
 * @param {any[]} [params.scopeParams] - 范围条件参数
 * @returns {Object} { list: [], total: number }
 */
function getFilterOptionsPaginated({
  userId,
  type,
  pageNo = 1,
  pageSize = 20,
  mediaType = null,
  scopeConditions = null,
  scopeParams = null,
}) {
  try {
    const offset = (pageNo - 1) * pageSize;
    let list = [];
    let total = 0;

    // 将 scope 条件从 "i." 转为 "media."
    const scopeClause =
      scopeConditions && scopeConditions.length > 0
        ? " AND " + scopeConditions.map((c) => c.replace(/\bi\./g, "media.")).join(" AND ")
        : "";
    // mediaType 过滤：当为 image/video 时，只统计对应类型的媒体
    const mediaClause =
      mediaType && ["image", "video"].includes(mediaType) ? " AND media_type = ?" : "";
    const mediaParams = mediaClause ? [mediaType] : [];
    const baseParams = [...mediaParams, ...(scopeParams && scopeParams.length > 0 ? scopeParams : [])];

    switch (type) {
      case "city": {
        const cityData = db
          .prepare(
            `
          SELECT (${LOC_KEY_MEDIA}) AS loc_key, COUNT(*) as count
          FROM media
          WHERE user_id = ? AND (${LOC_KEY_MEDIA}) IS NOT NULL${mediaClause}${scopeClause}
          GROUP BY (${LOC_KEY_MEDIA})
          ORDER BY count DESC
          LIMIT ? OFFSET ?
        `
          )
          .all(userId, ...baseParams, pageSize, offset);

        const cityTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT (${LOC_KEY_MEDIA})) as total
          FROM media
          WHERE user_id = ? AND (${LOC_KEY_MEDIA}) IS NOT NULL${mediaClause}${scopeClause}
        `
          )
          .get(userId, ...baseParams);

        list = cityData.map((c) => c.loc_key);
        total = cityTotal.total;
        break;
      }

      case "year": {
        const yearData = db
          .prepare(
            `
          SELECT year_key, COUNT(*) as count
          FROM media 
          WHERE user_id = ? AND year_key != 'unknown'${mediaClause}${scopeClause}
          GROUP BY year_key
          ORDER BY year_key DESC
          LIMIT ? OFFSET ?
        `
          )
          .all(userId, ...baseParams, pageSize, offset);

        const yearTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT year_key) as total
          FROM media 
          WHERE user_id = ? AND year_key != 'unknown'${mediaClause}${scopeClause}
        `
          )
          .get(userId, ...baseParams);

        list = yearData.map((y) => y.year_key);
        total = yearTotal.total;
        break;
      }

      case "month": {
        const monthData = db
          .prepare(
            `
          SELECT month_key, COUNT(*) as count
          FROM media 
          WHERE user_id = ? AND month_key != 'unknown'${mediaClause}${scopeClause}
          GROUP BY month_key
          ORDER BY month_key DESC
          LIMIT ? OFFSET ?
        `
          )
          .all(userId, ...baseParams, pageSize, offset);

        const monthTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT month_key) as total
          FROM media 
          WHERE user_id = ? AND month_key != 'unknown'${mediaClause}${scopeClause}
        `
          )
          .get(userId, ...baseParams);

        list = monthData.map((m) => m.month_key);
        total = monthTotal.total;
        break;
      }

      case "weekday": {
        const weekdayData = db
          .prepare(
            `
          SELECT day_key, COUNT(*) as count
          FROM media 
          WHERE user_id = ? AND day_key != 'unknown'${mediaClause}${scopeClause}
          GROUP BY day_key
          ORDER BY 
            CASE day_key
              WHEN 'Monday' THEN 1
              WHEN 'Tuesday' THEN 2
              WHEN 'Wednesday' THEN 3
              WHEN 'Thursday' THEN 4
              WHEN 'Friday' THEN 5
              WHEN 'Saturday' THEN 6
              WHEN 'Sunday' THEN 7
              ELSE 8
            END
          LIMIT ? OFFSET ?
        `
          )
          .all(userId, ...baseParams, pageSize, offset);

        const weekdayTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT day_key) as total
          FROM media 
          WHERE user_id = ? AND day_key != 'unknown'${mediaClause}${scopeClause}
        `
          )
          .get(userId, ...baseParams);

        list = weekdayData.map((w) => w.day_key);
        total = weekdayTotal.total;
        break;
      }
      default:
        throw new Error(`Unknown filter type: ${type}`);
    }

    return {
      list,
      total,
    };
  } catch (error) {
    console.error("分页获取筛选选项失败:", error);
    throw error;
  }
}

module.exports = {
  listMediaSearchResults,
  countMediaSearchResults,
  recallMediaIdsByFts,
  recallMediaIdsByFiltersOnly,
  recallMediaIdsByOcrTextLike,
  recallMediaIdsByChineseTerms,
  countMediaIdsByChineseTerms,
  getFilterOptionsPaginated,
  getMediasByIds,
};
