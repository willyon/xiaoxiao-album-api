/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 自然语言搜索功能和算法
 */

const { db } = require("../../db");
const { mapFields } = require("../../utils/fieldMapper");
const { sqlLocationKeyNullable } = require("./mediaLocationSql");

const LOC_KEY_MEDIA = sqlLocationKeyNullable("media");
const MEDIA_SEARCH_SELECT_COLUMNS = `
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
  i.age_tags AS age_tags,
  i.expression_tags AS expression_tags,
  i.is_favorite
`;

/**
 * 规范化搜索结果行字段。
 * @param {Array<object>} rows - 原始行列表。
 * @returns {Array<object>} 映射后的行列表。
 */
function normalizeSearchRows(rows) {
  return mapFields("media", rows);
}

function appendWhereConditions(sql, whereConditions = []) {
  if (!Array.isArray(whereConditions) || whereConditions.length === 0) {
    return sql;
  }
  return `${sql} AND ${whereConditions.join(" AND ")}`;
}

function buildMediaSearchBaseQuery({ includeFts = false, selectClause }) {
  const sourceSql = includeFts
    ? `
      FROM media_search_fts fts
      JOIN media_search ms ON fts.rowid = ms.media_id
      JOIN media i ON ms.media_id = i.id
      WHERE i.user_id = ?
        AND i.deleted_at IS NULL
        AND media_search_fts MATCH ?
    `
    : `
      FROM media i
      WHERE i.user_id = ?
        AND i.deleted_at IS NULL
    `;
  return `${selectClause}${sourceSql}`;
}

const WEEKDAY_ORDER_SQL = `
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
`;

const FILTER_OPTION_CONFIGS = {
  city: {
    valueExpr: `(${LOC_KEY_MEDIA})`,
    valueAlias: "loc_key",
    notNullClause: `(${LOC_KEY_MEDIA}) IS NOT NULL`,
    orderBy: "count DESC",
  },
  year: {
    valueExpr: "year_key",
    valueAlias: "year_key",
    notNullClause: "year_key != 'unknown'",
    orderBy: "year_key DESC",
  },
  month: {
    valueExpr: "month_key",
    valueAlias: "month_key",
    notNullClause: "month_key != 'unknown'",
    orderBy: "month_key DESC",
  },
  weekday: {
    valueExpr: "day_key",
    valueAlias: "day_key",
    notNullClause: "day_key != 'unknown'",
    orderBy: WEEKDAY_ORDER_SQL,
  },
};

function getFilterOptionConfig(type) {
  const config = FILTER_OPTION_CONFIGS[type];
  if (!config) {
    throw new Error(`Unknown filter type: ${type}`);
  }
  return config;
}

function listFilterOptionsByType({
  userId,
  config,
  mediaClause,
  scopeClause,
  baseParams,
  pageSize,
  offset,
}) {
  const sql = `
    SELECT ${config.valueExpr} AS ${config.valueAlias}, COUNT(*) as count
    FROM media
    WHERE user_id = ? AND ${config.notNullClause}${mediaClause}${scopeClause}
    GROUP BY ${config.valueExpr}
    ORDER BY ${config.orderBy}
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(userId, ...baseParams, pageSize, offset);
}

function countFilterOptionsByType({ userId, config, mediaClause, scopeClause, baseParams }) {
  const sql = `
    SELECT COUNT(DISTINCT ${config.valueExpr}) as total
    FROM media
    WHERE user_id = ? AND ${config.notNullClause}${mediaClause}${scopeClause}
  `;
  return db.prepare(sql).get(userId, ...baseParams);
}

/**
 * 列出媒体搜索结果（支持复杂筛选条件）
 * @param {Object} params - 查询参数。
 * @param {number|string} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array<any>} params.whereParams - WHERE 条件参数
 * @param {number} params.limit - 返回结果数量
 * @param {number} params.offset - 偏移量
 * @returns {Array<object>} 搜索结果
 */
function listMediaSearchResults({ userId, ftsQuery, whereConditions = [], whereParams = [], limit = 50, offset = 0 }) {
  const includeFts = Boolean(ftsQuery);
  let sql = buildMediaSearchBaseQuery({
    includeFts,
    selectClause: `SELECT ${MEDIA_SEARCH_SELECT_COLUMNS}`,
  });
  sql = appendWhereConditions(sql, whereConditions);
  sql += includeFts
    ? `
      ORDER BY fts.rank ASC, i.captured_at DESC
      LIMIT ? OFFSET ?
    `
    : `
      ORDER BY i.captured_at DESC
      LIMIT ? OFFSET ?
    `;
  const params = includeFts
    ? [userId, ftsQuery, ...whereParams, limit, offset]
    : [userId, ...whereParams, limit, offset];

  const stmt = db.prepare(sql);
  const results = stmt.all(...params);
  return normalizeSearchRows(results);
}

/**
 * 统计媒体搜索结果总数
 * @param {Object} params - 查询参数。
 * @param {number|string} params.userId - 用户ID
 * @param {string|null} params.ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @param {Array<string>} params.whereConditions - WHERE 条件数组
 * @param {Array<any>} params.whereParams - WHERE 条件参数
 * @returns {number} 总记录数
 */
function countMediaSearchResults({ userId, ftsQuery, whereConditions = [], whereParams = [] }) {
  const includeFts = Boolean(ftsQuery);
  let sql = buildMediaSearchBaseQuery({
    includeFts,
    selectClause: "SELECT COUNT(*) as total",
  });
  sql = appendWhereConditions(sql, whereConditions);
  const params = includeFts ? [userId, ftsQuery, ...whereParams] : [userId, ...whereParams];

  const stmt = db.prepare(sql);
  const result = stmt.get(...params);
  return result ? result.total : 0;
}

/**
 * 使用 FTS 召回媒体 ID 与分值。
 * @param {{userId:number|string,ftsQuery:string,whereConditions?:Array<string>,whereParams?:Array<any>,limit?:number}} [params] - 查询参数。
 * @returns {Array<{media_id:number,fts_score:number,captured_at:number}>} 召回结果。
 */
function recallMediaIdsByFts({ userId, ftsQuery, whereConditions = [], whereParams = [], limit } = {}) {
  if (!ftsQuery) {
    return [];
  }

  let sql = `
    SELECT
      i.id AS media_id,
      bm25(media_search_fts, 6.0, 7.0, 11.0, 12.0, 9.0, 3.0, 14.0) AS fts_score,
      i.captured_at
  `;
  sql = buildMediaSearchBaseQuery({ includeFts: true, selectClause: sql });
  sql = appendWhereConditions(sql, whereConditions);
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
 * @param {{userId:number|string,whereConditions?:Array<string>,whereParams?:Array<any>,limit?:number}} [params] - 查询参数。
 * @returns {Array<{media_id:number,captured_at:number}>} 召回结果。
 */
function recallMediaIdsByFiltersOnly({ userId, whereConditions = [], whereParams = [], limit = 200000 } = {}) {
  let sql = `
    SELECT
      i.id AS media_id,
      i.captured_at
  `;
  sql = buildMediaSearchBaseQuery({ includeFts: false, selectClause: sql });
  sql = appendWhereConditions(sql, whereConditions);
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
 * @param {{userId:number|string,likePattern:string,whereConditions?:Array<string>,whereParams?:Array<any>,limit?:number}} [params] - 查询参数。
 * @returns {Array<{media_id:number,captured_at:number}>} 命中结果。
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

/**
 * 按中文 terms 召回媒体命中明细。
 * @param {{userId:number|string,terms?:Array<string>,whereConditions?:Array<string>,whereParams?:Array<any>,limit?:number,fieldTypes?:Array<string>}} [params] - 查询参数。
 * @returns {Array<{media_id:number,field_type:string,term:string,term_len:number,captured_at:number}>} 命中明细。
 */
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

/**
 * 统计中文 terms 命中的去重媒体数。
 * @param {{userId:number|string,terms?:Array<string>,whereConditions?:Array<string>,whereParams?:Array<any>}} params - 查询参数。
 * @returns {number} 去重媒体数。
 */
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
 * 根据媒体 ID 列表获取媒体信息
 * @param {{userId:number|string,mediaIds:Array<number|string>}} params - 查询参数。
 * @returns {Array<object>} 媒体信息列表
 */
function getMediasByIds({ userId, mediaIds }) {
  if (!mediaIds || mediaIds.length === 0) {
    return [];
  }

  const placeholders = mediaIds.map(() => "?").join(",");
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
      i.age_tags AS age_tags,
      i.expression_tags AS expression_tags,
      i.is_favorite
    FROM media i
    WHERE i.user_id = ?
      AND i.deleted_at IS NULL
      AND i.id IN (${placeholders})
    ORDER BY i.captured_at DESC
  `;

  const stmt = db.prepare(sql);
  const results = stmt.all(userId, ...mediaIds);
  return normalizeSearchRows(results);
}

/**
 * 分页获取筛选选项列表（支持 scope：在当前维度下的选项）
 * @param {Object} params - 查询参数。
 * @param {number|string} params.userId - 用户ID
 * @param {string} params.type - 选项类型: 'city' | 'year' | 'month' | 'weekday'
 * @param {number} params.pageNo - 页码（从1开始）
 * @param {number} params.pageSize - 每页数量（默认20）
 * @param {string|null} [params.mediaType] - 媒体类型：'image' | 'video'，null 或 'all' 表示不过滤
 * @param {string[]} [params.scopeConditions] - 范围条件（表别名 i.，内部会转为 images.）
 * @param {any[]} [params.scopeParams] - 范围条件参数
 * @returns {{list:Array<string>,total:number}} { list: [], total: number }
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
  const offset = (pageNo - 1) * pageSize;
  let list = [];
  let total = 0;

  // 将 scope 条件从 "i." 转为 "media."
  const scopeClause =
    scopeConditions && scopeConditions.length > 0
      ? " AND " + scopeConditions.map((c) => c.replace(/\bi\./g, "media.")).join(" AND ")
      : "";
  // mediaType 过滤：当为 image/video 时，只统计对应类型的媒体
  const mediaClause = mediaType && ["image", "video"].includes(mediaType) ? " AND media_type = ?" : "";
  const mediaParams = mediaClause ? [mediaType] : [];
  const baseParams = [...mediaParams, ...(scopeParams && scopeParams.length > 0 ? scopeParams : [])];
  const config = getFilterOptionConfig(type);
  const rows = listFilterOptionsByType({
    userId,
    config,
    mediaClause,
    scopeClause,
    baseParams,
    pageSize,
    offset,
  });
  const totalRow = countFilterOptionsByType({
    userId,
    config,
    mediaClause,
    scopeClause,
    baseParams,
  });
  list = rows.map((item) => item[config.valueAlias]);
  total = totalRow?.total || 0;

  return {
    list,
    total,
  };
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
