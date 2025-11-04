/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 自然语言搜索功能和算法
 */

const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");

/**
 * 全文搜索图片（支持复杂筛选条件）
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.query - FTS 查询字符串（如果为空，则不使用 FTS）
 * @param {boolean} params.useFts - 是否使用 FTS 查询
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @param {number} params.limit - 返回结果数量
 * @param {number} params.offset - 偏移量
 * @returns {Array} 搜索结果
 */
function searchImagesByText({ userId, query, useFts = true, whereConditions = [], whereParams = [], limit = 50, offset = 0 }) {
  let sql;
  let params;

  if (useFts && query) {
    // 使用 FTS 查询
    sql = `
      SELECT 
        i.thumbnail_storage_key,
        i.high_res_storage_key,
        i.image_created_at,
        i.date_key,
        i.month_key,
        i.year_key,
        i.day_key,
        i.gps_location,
        i.storage_type,
        i.alt_text,
        i.ocr_text,
        i.keywords,
        i.scene_tags,
        i.object_tags,
        i.width_px,
        i.height_px,
        i.aspect_ratio,
        i.layout_type,
        i.color_theme,
        i.file_size_bytes,
        i.face_count,
        i.person_count,
        i.age_tags,
        i.gender_tags,
        i.expression_tags,
        i.has_young,
        i.has_adult,
        fts.rank
      FROM images_fts fts
      JOIN images i ON fts.rowid = i.id
      WHERE i.user_id = ? 
        AND images_fts MATCH ?
    `;

    // 添加额外的 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += `
      ORDER BY fts.rank DESC, i.image_created_at DESC
      LIMIT ? OFFSET ?
    `;

    params = [userId, query, ...whereParams, limit, offset];
  } else {
    // 不使用 FTS，直接查询 images 表（用于纯筛选或查询所有图片）
    sql = `
      SELECT 
        i.thumbnail_storage_key,
        i.high_res_storage_key,
        i.image_created_at,
        i.date_key,
        i.month_key,
        i.year_key,
        i.day_key,
        i.gps_location,
        i.storage_type,
        i.alt_text,
        i.ocr_text,
        i.keywords,
        i.scene_tags,
        i.object_tags,
        i.width_px,
        i.height_px,
        i.aspect_ratio,
        i.layout_type,
        i.color_theme,
        i.file_size_bytes,
        i.face_count,
        i.person_count,
        i.age_tags,
        i.gender_tags,
        i.expression_tags,
        i.has_young,
        i.has_adult,
        0 as rank
      FROM images i
      WHERE i.user_id = ?
    `;

    // 添加 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += `
      ORDER BY i.image_created_at DESC
      LIMIT ? OFFSET ?
    `;

    params = [userId, ...whereParams, limit, offset];
  }

  const stmt = db.prepare(sql);
  const results = stmt.all(...params);
  return mapFields("images", results);
}

/**
 * 获取搜索结果总数
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.query - FTS 查询字符串
 * @param {boolean} params.useFts - 是否使用 FTS 查询
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array} params.whereParams - WHERE 条件参数
 * @returns {number} 总记录数
 */
function getSearchResultsCount({ userId, query, useFts = true, whereConditions = [], whereParams = [] }) {
  let sql;
  let params;

  if (useFts && query) {
    // 使用 FTS 查询计数
    sql = `
      SELECT COUNT(*) as total
      FROM images_fts fts
      JOIN images i ON fts.rowid = i.id
      WHERE i.user_id = ? 
        AND images_fts MATCH ?
    `;

    // 添加额外的 WHERE 条件
    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    params = [userId, query, ...whereParams];
  } else {
    // 直接查询 images 表计数
    sql = `
      SELECT COUNT(*) as total
      FROM images i
      WHERE i.user_id = ?
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
 * 获取搜索建议（基于现有标签）
 */
function getSearchSuggestions({ userId, prefix = "", limit = 10 }) {
  const suggestions = [];

  // 从各个标签字段获取建议
  // 注意：这些字段 = NULL 表示未分析，排除NULL
  const tagFields = ["scene_tags", "object_tags", "keywords"];

  tagFields.forEach((field) => {
    const sql = `
      SELECT DISTINCT ${field} as tags
      FROM images 
      WHERE user_id = ? 
        AND ${field} IS NOT NULL
        AND ${field} != '' 
        AND ${field} LIKE ?
      LIMIT ?
    `;

    const stmt = db.prepare(sql);
    const results = stmt.all(userId, `${prefix}%`, limit);

    results.forEach((row) => {
      if (row.tags) {
        const tags = row.tags.split(",").map((tag) => tag.trim());
        tags.forEach((tag) => {
          if (tag.toLowerCase().includes(prefix.toLowerCase()) && !suggestions.includes(tag)) {
            suggestions.push(tag);
          }
        });
      }
    });
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
        -- 是否有人统计（只统计已分析的，排除NULL）
        SUM(CASE WHEN person_count IS NOT NULL AND person_count > 0 THEN 1 ELSE 0 END) as has_person,
        SUM(CASE WHEN person_count IS NOT NULL AND person_count = 0 THEN 1 ELSE 0 END) as no_person,
        
        -- 人脸数量统计（只统计已分析的，排除NULL）
        SUM(CASE WHEN face_count IS NOT NULL AND face_count = 0 THEN 1 ELSE 0 END) as face_zero,
        SUM(CASE WHEN face_count IS NOT NULL AND face_count = 1 THEN 1 ELSE 0 END) as face_one,
        SUM(CASE WHEN face_count IS NOT NULL AND face_count = 2 THEN 1 ELSE 0 END) as face_two,
        SUM(CASE WHEN face_count IS NOT NULL AND face_count >= 3 THEN 1 ELSE 0 END) as face_three_plus,
        
        -- 年龄段统计（只统计已分析的，排除NULL）
        SUM(CASE WHEN has_young IS NOT NULL AND has_young = 1 THEN 1 ELSE 0 END) as has_young_count,
        SUM(CASE WHEN has_adult IS NOT NULL AND has_adult = 1 THEN 1 ELSE 0 END) as has_adult_count,
        
        -- 版式统计（使用 MAX 聚合函数配合 CASE 获取各类型数量）
        SUM(CASE WHEN layout_type = 'portrait' THEN 1 ELSE 0 END) as layout_portrait,
        SUM(CASE WHEN layout_type = 'landscape' THEN 1 ELSE 0 END) as layout_landscape,
        SUM(CASE WHEN layout_type = 'square' THEN 1 ELSE 0 END) as layout_square,
        SUM(CASE WHEN layout_type = 'panorama' THEN 1 ELSE 0 END) as layout_panorama,
        
        -- 颜色主题统计
        SUM(CASE WHEN color_theme = 'vibrant' THEN 1 ELSE 0 END) as color_vibrant,
        SUM(CASE WHEN color_theme = 'bright' THEN 1 ELSE 0 END) as color_bright,
        SUM(CASE WHEN color_theme = 'neutral' THEN 1 ELSE 0 END) as color_neutral,
        SUM(CASE WHEN color_theme = 'muted' THEN 1 ELSE 0 END) as color_muted,
        SUM(CASE WHEN color_theme = 'dim' THEN 1 ELSE 0 END) as color_dim,
        
        -- 分辨率统计（与搜索条件保持一致：同时满足宽和高，支持横向/纵向）
        SUM(CASE WHEN ((width_px >= 7680 AND height_px >= 4320) OR (width_px >= 4320 AND height_px >= 7680)) THEN 1 ELSE 0 END) as res_8k,
        SUM(CASE WHEN ((width_px >= 3840 AND height_px >= 2160) OR (width_px >= 2160 AND height_px >= 3840)) THEN 1 ELSE 0 END) as res_4k,
        SUM(CASE WHEN ((width_px >= 1920 AND height_px >= 1080) OR (width_px >= 1080 AND height_px >= 1920)) THEN 1 ELSE 0 END) as res_fhd,
        SUM(CASE WHEN (NOT ((width_px >= 1920 AND height_px >= 1080) OR (width_px >= 1080 AND height_px >= 1920))) THEN 1 ELSE 0 END) as res_hd
      FROM images
      WHERE user_id = ?
    `,
      )
      .get(userId);

    // 4. 获取表情和性别的不同值（需要解析逗号分隔字符串）
    // 注意：expression_tags/gender_tags = NULL 表示未分析，排除NULL
    const expressionRows = db
      .prepare(
        `
      SELECT DISTINCT expression_tags
      FROM images
      WHERE user_id = ? AND expression_tags IS NOT NULL AND expression_tags != ''
      LIMIT 100
    `,
      )
      .pluck()
      .all(userId);

    const genderRows = db
      .prepare(
        `
      SELECT DISTINCT gender_tags
      FROM images
      WHERE user_id = ? AND gender_tags IS NOT NULL AND gender_tags != ''
      LIMIT 100
    `,
      )
      .pluck()
      .all(userId);

    // 解析表情标签（去重）
    const expressionSet = new Set();
    expressionRows.forEach((tags) => {
      tags.split(",").forEach((tag) => {
        const trimmed = tag.trim();
        if (trimmed) expressionSet.add(trimmed);
      });
    });

    // 解析性别标签（去重）
    const genderSet = new Set();
    genderRows.forEach((tags) => {
      tags.split(",").forEach((tag) => {
        const trimmed = tag.trim();
        if (trimmed) genderSet.add(trimmed);
      });
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

      // 性别选项（实际存在的性别）
      genders: Array.from(genderSet),

      // 年龄段统计
      ageStats: {
        minor: stats.has_young_count || 0,
        adult: stats.has_adult_count || 0,
      },

      // 分辨率统计
      resolutionStats: {
        hd: stats.res_hd || 0,
        fhd1080p: stats.res_fhd || 0,
        "4k": stats.res_4k || 0,
        "8k": stats.res_8k || 0,
      },

      // 图片版式统计
      layoutStats: {
        portrait: stats.layout_portrait || 0,
        landscape: stats.layout_landscape || 0,
        square: stats.layout_square || 0,
        panorama: stats.layout_panorama || 0,
      },

      // 颜色主题统计
      colorThemeStats: {
        vibrant: stats.color_vibrant || 0,
        bright: stats.color_bright || 0,
        neutral: stats.color_neutral || 0,
        muted: stats.color_muted || 0,
        dim: stats.color_dim || 0,
      },
    };
  } catch (error) {
    console.error("获取筛选选项失败:", error);
    throw error;
  }
}

/**
 * 分页获取筛选选项列表
 * @param {Object} params
 * @param {number} params.userId - 用户ID
 * @param {string} params.type - 选项类型: 'city' | 'year' | 'month' | 'day' | 'weekday'
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量（默认20）
 * @returns {Object} { data: [], total: 0, hasMore: false }
 */
function getFilterOptionsPaginated({ userId, type, pageNo = 1, pageSize = 20, timeDimension = null }) {
  try {
    const offset = (pageNo - 1) * pageSize;
    let data = [];
    let total = 0;

    switch (type) {
      case "city": {
        // 获取城市列表（按图片数量降序）
        const cityData = db
          .prepare(
            `
          SELECT city, COUNT(*) as count
          FROM images 
          WHERE user_id = ? AND city IS NOT NULL AND city != ''
          GROUP BY city
          ORDER BY count DESC
          LIMIT ? OFFSET ?
        `,
          )
          .all(userId, pageSize, offset);

        const cityTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT city) as total
          FROM images 
          WHERE user_id = ? AND city IS NOT NULL AND city != ''
        `,
          )
          .get(userId);

        data = cityData.map((c) => ({ value: c.city, label: c.city, count: c.count }));
        total = cityTotal.total;
        break;
      }

      case "year": {
        // 获取年份列表（降序）
        const yearData = db
          .prepare(
            `
          SELECT year_key, COUNT(*) as count
          FROM images 
          WHERE user_id = ? AND year_key != 'unknown'
          GROUP BY year_key
          ORDER BY year_key DESC
          LIMIT ? OFFSET ?
        `,
          )
          .all(userId, pageSize, offset);

        const yearTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT year_key) as total
          FROM images 
          WHERE user_id = ? AND year_key != 'unknown'
        `,
          )
          .get(userId);

        data = yearData.map((y) => ({ value: y.year_key, label: y.year_key, count: y.count }));
        total = yearTotal.total;
        break;
      }

      case "month": {
        // 获取月份列表（YYYY-MM格式，降序）
        const monthData = db
          .prepare(
            `
          SELECT month_key, COUNT(*) as count
          FROM images 
          WHERE user_id = ? AND month_key != 'unknown'
          GROUP BY month_key
          ORDER BY month_key DESC
          LIMIT ? OFFSET ?
        `,
          )
          .all(userId, pageSize, offset);

        const monthTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT month_key) as total
          FROM images 
          WHERE user_id = ? AND month_key != 'unknown'
        `,
          )
          .get(userId);

        data = monthData.map((m) => ({ value: m.month_key, label: m.month_key, count: m.count }));
        total = monthTotal.total;
        break;
      }

      case "day": {
        // 获取完整的日期列表（YYYY-MM-DD格式，降序）
        const dayData = db
          .prepare(
            `
          SELECT date_key, COUNT(*) as count
          FROM images 
          WHERE user_id = ? AND date_key != 'unknown'
          GROUP BY date_key
          ORDER BY date_key DESC
          LIMIT ? OFFSET ?
        `,
          )
          .all(userId, pageSize, offset);

        const dayTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT date_key) as total
          FROM images 
          WHERE user_id = ? AND date_key != 'unknown'
        `,
          )
          .get(userId);

        data = dayData.map((d) => ({ value: d.date_key, label: d.date_key, count: d.count }));
        total = dayTotal.total;
        break;
      }

      case "weekday": {
        // 获取星期几列表（从 day_key 字段，固定顺序）
        // day_key 存储的是星期几：'Monday', 'Tuesday', ..., 'Sunday'
        const weekdayData = db
          .prepare(
            `
          SELECT day_key, COUNT(*) as count
          FROM images 
          WHERE user_id = ? AND day_key != 'unknown'
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
        `,
          )
          .all(userId, pageSize, offset);

        const weekdayTotal = db
          .prepare(
            `
          SELECT COUNT(DISTINCT day_key) as total
          FROM images 
          WHERE user_id = ? AND day_key != 'unknown'
        `,
          )
          .get(userId);

        // 星期几映射（day_key 是英文，前端可能需要中文）
        const weekdayMap = {
          Monday: "周一",
          Tuesday: "周二",
          Wednesday: "周三",
          Thursday: "周四",
          Friday: "周五",
          Saturday: "周六",
          Sunday: "周日",
        };

        data = weekdayData.map((w) => ({
          value: w.day_key,
          label: weekdayMap[w.day_key] || w.day_key,
          count: w.count,
        }));
        total = weekdayTotal.total;
        break;
      }

      default:
        throw new Error(`Unknown filter type: ${type}`);
    }

    return {
      data,
      total,
      pageNo,
      pageSize,
      hasMore: offset + data.length < total,
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
};
