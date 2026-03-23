/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 自然语言搜索功能和算法
 */

const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");

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
        COALESCE(i.expression_tags, i.primary_expression) AS expression_tags,
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
        COALESCE(i.expression_tags, i.primary_expression) AS expression_tags,
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
      bm25(media_search_fts, 6.0, 7.0, 11.0, 12.0, 9.0, 8.0, 3.0, 14.0) AS fts_score,
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
 * 仅对 media_search_fts.ocr_search_terms 列做 MATCH（与图片理解列组分离；列为 OCR 的 jieba 空格串）。
 */
function recallMediaIdsByOcrFts({ userId, ftsQuery, whereConditions = [], whereParams = [], limit } = {}) {
  if (!ftsQuery) {
    return [];
  }

  let sql = `
    SELECT
      i.id AS media_id,
      bm25(media_search_fts, 6.0, 7.0, 11.0, 12.0, 9.0, 8.0, 3.0, 14.0) AS fts_score,
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

function getSearchDocsByMediaIds({ userId, imageIds }) {
  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    return [];
  }

  const placeholders = imageIds.map(() => "?").join(",");
  const sql = `
    SELECT
      ms.media_id,
      ms.description_text,
      ms.keywords_text,
      ms.subject_tags_text,
      ms.action_tags_text,
      ms.scene_tags_text,
      ms.ocr_text,
      ms.ocr_search_terms,
      ms.transcript_text
    FROM media_search ms
    JOIN media i ON i.id = ms.media_id
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND ms.media_id IN (${placeholders})
  `;

  return db.prepare(sql).all(userId, ...imageIds);
}

function recallMediaIdsByChineseTerms({
  userId,
  terms = [],
  whereConditions = [],
  whereParams = [],
  limit,
  fieldTypes,
  excludeFieldTypes,
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
  if (Array.isArray(excludeFieldTypes) && excludeFieldTypes.length > 0) {
    const exPh = excludeFieldTypes.map(() => "?").join(",");
    sql += ` AND mst.field_type NOT IN (${exPh})`;
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
  if (Array.isArray(excludeFieldTypes) && excludeFieldTypes.length > 0) {
    params.push(...excludeFieldTypes);
  }
  params.push(...whereParams);
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

/** 仅图片理解：media_search_terms 中排除 OCR 行，与 OCR 召回分离。 */
function recallMediaIdsByChineseTermsForVisual(params) {
  return recallMediaIdsByChineseTerms({
    ...params,
    excludeFieldTypes: ["ocr"],
  });
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
      COALESCE(i.expression_tags, i.primary_expression) AS expression_tags,
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
 * 获取筛选选项的可用值（优化版：合并查询）
 * 用于筛选侧栏初始化时获取所有可用的筛选选项及其统计信息
 */
function getFilterOptions(userId) {
  try {
    // 注：城市和时间选项已改为分页获取，此接口不再返回这些数据
    // 请使用 getFilterOptionsPaginated 接口获取分页数据

    // 3. 一次性获取所有统计数据（使用单个查询优化性能）
    const stats = db
      .prepare(
        `
      SELECT 
        SUM(CASE WHEN COALESCE(i.person_count, 0) > 0 THEN 1 ELSE 0 END) as has_person,
        SUM(CASE WHEN COALESCE(i.person_count, 0) = 0 THEN 1 ELSE 0 END) as no_person,
        
        SUM(CASE WHEN COALESCE(i.face_count, 0) = 0 THEN 1 ELSE 0 END) as face_zero,
        SUM(CASE WHEN COALESCE(i.face_count, 0) = 1 THEN 1 ELSE 0 END) as face_one,
        SUM(CASE WHEN COALESCE(i.face_count, 0) = 2 THEN 1 ELSE 0 END) as face_two,
        SUM(CASE WHEN COALESCE(i.face_count, 0) >= 3 THEN 1 ELSE 0 END) as face_three_plus,
        
        -- 版式统计（使用 MAX 聚合函数配合 CASE 获取各类型数量）
        SUM(CASE WHEN layout_type = 'portrait' THEN 1 ELSE 0 END) as layout_portrait,
        SUM(CASE WHEN layout_type = 'landscape' THEN 1 ELSE 0 END) as layout_landscape,
        SUM(CASE WHEN layout_type = 'square' THEN 1 ELSE 0 END) as layout_square,
        SUM(CASE WHEN layout_type = 'panorama' THEN 1 ELSE 0 END) as layout_panorama,
        
        -- 分辨率统计（与搜索条件保持一致：同时满足宽和高，支持横向/纵向）
        SUM(CASE WHEN ((width_px >= 7680 AND height_px >= 4320) OR (width_px >= 4320 AND height_px >= 7680)) THEN 1 ELSE 0 END) as res_8k,
        SUM(CASE WHEN ((width_px >= 3840 AND height_px >= 2160) OR (width_px >= 2160 AND height_px >= 3840)) THEN 1 ELSE 0 END) as res_4k,
        SUM(CASE WHEN ((width_px >= 1920 AND height_px >= 1080) OR (width_px >= 1080 AND height_px >= 1920)) THEN 1 ELSE 0 END) as res_fhd,
        SUM(CASE WHEN (NOT ((width_px >= 1920 AND height_px >= 1080) OR (width_px >= 1080 AND height_px >= 1920))) THEN 1 ELSE 0 END) as res_hd
      FROM media i
      WHERE i.user_id = ?
    `,
      )
      .get(userId);

    // 4. 获取表情的不同值（需要解析逗号分隔字符串）
    // 注意：expression_tags = NULL 表示未分析，排除NULL
    const expressionRows = db
      .prepare(
        `
      SELECT DISTINCT i.primary_expression
      FROM media i
      WHERE i.user_id = ? AND i.primary_expression IS NOT NULL AND i.primary_expression != ''
      LIMIT 100
    `,
      )
      .pluck()
      .all(userId);

    // 解析表情标签（去重）
    const expressionSet = new Set();
    expressionRows.forEach((tags) => {
      const trimmed = String(tags).trim();
      if (trimmed) expressionSet.add(trimmed);
    });

    // 5. 组装返回数据（不再包含cities和years，改用分页接口）
    return {
      // 是否有人统计
      hasPersonStats: {
        withPerson: stats.has_person || 0,
        withoutPerson: stats.no_person || 0,
      },

      // 人脸数量统计
      faceCountStats: {
        zero: stats.face_zero || 0,
        one: stats.face_one || 0,
        two: stats.face_two || 0,
        threePlus: stats.face_three_plus || 0,
      },

      // 表情选项（实际存在的表情）
      expressions: Array.from(expressionSet),

      // 分辨率统计
      resolutionStats: {
        sd: stats.res_hd || 0,
        fhd: stats.res_fhd || 0,
        uhd4k: stats.res_4k || 0,
        uhd8k: stats.res_8k || 0,
      },

      // 图片版式统计
      layoutStats: {
        portrait: stats.layout_portrait || 0,
        landscape: stats.layout_landscape || 0,
        square: stats.layout_square || 0,
        panorama: stats.layout_panorama || 0,
      },

    };
  } catch (error) {
    console.error("获取筛选选项失败:", error);
    throw error;
  }
}

/**
 * 分页获取筛选选项列表（支持 scope：在当前维度下的选项）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.type - 选项类型: 'city' | 'year' | 'month' | 'weekday'
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量（默认20）
 * @param {string} params.timeDimension - 时间维度（可选）
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
  timeDimension = null,
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
          SELECT city, COUNT(*) as count
          FROM media 
          WHERE user_id = ? AND city IS NOT NULL AND city != ''${mediaClause}${scopeClause}
          GROUP BY city
          ORDER BY count DESC
          LIMIT ? OFFSET ?
        `
          )
          .all(userId, ...baseParams, pageSize, offset);

        const cityTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT city) as total
          FROM media 
          WHERE user_id = ? AND city IS NOT NULL AND city != ''${mediaClause}${scopeClause}
        `
          )
          .get(userId, ...baseParams);

        list = cityData.map((c) => c.city);
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
  recallMediaIdsByOcrFts,
  recallMediaIdsByChineseTerms,
  recallMediaIdsByChineseTermsForVisual,
  countMediaIdsByChineseTerms,
  getFilterOptionsPaginated,
  getMediasByIds,
  getSearchDocsByMediaIds,
};
