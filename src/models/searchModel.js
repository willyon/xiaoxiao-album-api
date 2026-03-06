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
 * 全文搜索图片（支持复杂筛选条件）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @param {number} params.limit - 返回结果数量
 * @param {number} params.offset - 偏移量
 * @returns {Array} 搜索结果
 */
function searchImagesByText({ userId, ftsQuery, whereConditions = [], whereParams = [], limit = 50, offset = 0 }) {
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
        COALESCE(ma.face_count, 0) AS face_count,
        COALESCE(ma.person_count, 0) AS person_count,
        NULL AS age_tags,
        ma.primary_expression AS expression_tags,
        i.is_favorite
      FROM media_fts fts
      JOIN media_search ms ON fts.rowid = ms.media_id
      JOIN media i ON ms.media_id = i.id
      LEFT JOIN media_analysis ma ON ma.media_id = i.id
      WHERE i.user_id = ? 
        AND i.deleted_at IS NULL
        AND media_fts MATCH ?
    `;

    // 添加额外的 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += `
      ORDER BY fts.rank DESC, i.captured_at DESC
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
        COALESCE(ma.face_count, 0) AS face_count,
        COALESCE(ma.person_count, 0) AS person_count,
        NULL AS age_tags,
        ma.primary_expression AS expression_tags,
        i.is_favorite
      FROM media i
      LEFT JOIN media_analysis ma ON ma.media_id = i.id
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
 * 获取搜索结果总数
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @returns {number} 总记录数
 */
function getSearchResultsCount({ userId, ftsQuery, whereConditions = [], whereParams = [] }) {
  let sql;
  let params;

  if (ftsQuery) {
    // 使用 FTS 查询计数
    sql = `
      SELECT COUNT(*) as total
      FROM media_fts fts
      JOIN media_search ms ON fts.rowid = ms.media_id
      JOIN media i ON ms.media_id = i.id
      LEFT JOIN media_analysis ma ON ma.media_id = i.id
      WHERE i.user_id = ? 
        AND i.deleted_at IS NULL
        AND media_fts MATCH ?
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
      LEFT JOIN media_analysis ma ON ma.media_id = i.id
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

/**
 * 根据图片 ID 列表获取图片信息（用于向量搜索结果）
 * @param {number} userId - 用户ID
 * @param {Array<number>} imageIds - 图片ID列表
 * @returns {Array} 图片信息列表
 */
function getImagesByIds({ userId, imageIds }) {
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
      COALESCE(ma.face_count, 0) AS face_count,
      COALESCE(ma.person_count, 0) AS person_count,
      NULL AS age_tags,
      ma.primary_expression AS expression_tags,
      i.is_favorite
    FROM media i
    LEFT JOIN media_analysis ma ON ma.media_id = i.id
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
 * 获取搜索建议（基于现有标签）
 * 改进：使用包含匹配（LIKE %prefix%），确保任意 tag 包含 prefix 都能被建议
 */
function getSearchSuggestions({ userId, prefix = "", limit = 10 }) {
  const suggestions = [];

  // 如果 prefix 为空，返回空数组
  if (!prefix || !prefix.trim()) {
    return [];
  }

  const normalizedPrefix = prefix.trim().toLowerCase();

  const sql = `
    SELECT caption_text, object_text, scene_text
    FROM media_search
    WHERE user_id = ?
      AND (
        caption_text IS NOT NULL
        OR object_text IS NOT NULL
        OR scene_text IS NOT NULL
      )
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(userId, limit * 20);
  rows.forEach((row) => {
    [row.caption_text, row.object_text, row.scene_text].forEach((text) => {
      if (!text) return;
      String(text)
        .split(/[,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean)
        .forEach((token) => {
          if (token.toLowerCase().includes(normalizedPrefix) && !suggestions.includes(token)) {
            suggestions.push(token);
          }
        });
    });
  });

  // 按长度和匹配位置排序：优先显示短且以 prefix 开头的 tag
  suggestions.sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aStartsWith = aLower.startsWith(normalizedPrefix);
    const bStartsWith = bLower.startsWith(normalizedPrefix);

    // 以 prefix 开头的优先
    if (aStartsWith && !bStartsWith) return -1;
    if (!aStartsWith && bStartsWith) return 1;

    // 长度短的优先
    return a.length - b.length;
  });

  return suggestions.slice(0, limit);
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
        SUM(CASE WHEN COALESCE(ma.person_count, 0) > 0 THEN 1 ELSE 0 END) as has_person,
        SUM(CASE WHEN COALESCE(ma.person_count, 0) = 0 THEN 1 ELSE 0 END) as no_person,
        
        SUM(CASE WHEN COALESCE(ma.face_count, 0) = 0 THEN 1 ELSE 0 END) as face_zero,
        SUM(CASE WHEN COALESCE(ma.face_count, 0) = 1 THEN 1 ELSE 0 END) as face_one,
        SUM(CASE WHEN COALESCE(ma.face_count, 0) = 2 THEN 1 ELSE 0 END) as face_two,
        SUM(CASE WHEN COALESCE(ma.face_count, 0) >= 3 THEN 1 ELSE 0 END) as face_three_plus,
        
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
      LEFT JOIN media_analysis ma ON ma.media_id = i.id
      WHERE i.user_id = ?
    `,
      )
      .get(userId);

    // 4. 获取表情的不同值（需要解析逗号分隔字符串）
    // 注意：expression_tags = NULL 表示未分析，排除NULL
    const expressionRows = db
      .prepare(
        `
      SELECT DISTINCT primary_expression
      FROM media_analysis ma
      JOIN media i ON i.id = ma.media_id
      WHERE i.user_id = ? AND ma.primary_expression IS NOT NULL AND ma.primary_expression != ''
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
  searchImagesByText,
  getSearchResultsCount,
  getSearchSuggestions,
  getFilterOptionsPaginated,
  getImagesByIds,
};
