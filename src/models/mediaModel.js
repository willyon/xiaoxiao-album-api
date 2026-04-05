/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 15:07:05
 * @Description: File description
 */
const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");
const { buildMediaSearchTermRows, buildSearchTermsFromFields } = require("../utils/searchTermUtils");
const { clearSearchRankCache } = require("../utils/searchRankCacheStore");
const { rebuildMediaEmbeddingDoc } = require("../services/mediaEmbeddingRebuildService");
const { deleteMediaEmbeddingBySourceType, MEDIA_EMBEDDING_SOURCE_TYPES } = require("./mediaEmbeddingModel");

/**
 * 单条媒体在筛选 / 地点相册分组中的「地点键」SQL 片段（优先 city，其次 province，否则 country）。
 * @param {string} alias 表别名，如 i、media
 * @returns {string} 可嵌入 SQL 的表达式（可空）
 */
function sqlLocationKeyNullable(alias) {
  const a = alias;
  return `(
    CASE
      WHEN ${a}.city IS NOT NULL AND TRIM(${a}.city) != '' AND ${a}.city != 'unknown' THEN TRIM(${a}.city)
      WHEN ${a}.province IS NOT NULL AND TRIM(${a}.province) != '' AND ${a}.province != 'unknown' THEN TRIM(${a}.province)
      WHEN ${a}.country IS NOT NULL AND TRIM(${a}.country) != '' AND ${a}.country != 'unknown' THEN TRIM(${a}.country)
      ELSE NULL
    END
  )`;
}

function sqlLocationAlbumKey(alias) {
  return `COALESCE(${sqlLocationKeyNullable(alias)}, 'unknown')`;
}

function sqlLocationIsUnknown(alias) {
  return `(${sqlLocationKeyNullable(alias)} IS NULL)`;
}

function parseCommaTags(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toJsonArrayString(input) {
  const arr = parseCommaTags(input);
  return arr.length > 0 ? JSON.stringify(arr) : null;
}

function normalizeTextArray(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const output = [];
  for (const item of input) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function parseJsonTextArray(input) {
  if (!input || typeof input !== "string") return [];
  try {
    return normalizeTextArray(JSON.parse(input));
  } catch {
    return [];
  }
}

function collectMediaSearchDocument(mediaId) {
  const media = db
    .prepare(
      `
      SELECT id, user_id, deleted_at,
             ai_description, ai_keywords_json, ai_subject_tags_json, ai_action_tags_json, ai_scene_tags_json,
             ai_ocr
      FROM media WHERE id = ?
    `,
    )
    .get(mediaId);
  if (!media) return null;

  const descriptionText = media.ai_description ? String(media.ai_description) : null;
  const keywordTokens = new Set(parseJsonTextArray(media.ai_keywords_json));
  const subjectTagTokens = new Set(parseJsonTextArray(media.ai_subject_tags_json));
  const actionTagTokens = new Set(parseJsonTextArray(media.ai_action_tags_json));
  const sceneTagTokens = new Set(parseJsonTextArray(media.ai_scene_tags_json));

  const keywordsText = keywordTokens.size > 0 ? Array.from(keywordTokens).join(" ") : null;
  const subjectTagsText = subjectTagTokens.size > 0 ? Array.from(subjectTagTokens).join(" ") : null;
  const actionTagsText = actionTagTokens.size > 0 ? Array.from(actionTagTokens).join(" ") : null;
  const sceneTagsText = sceneTagTokens.size > 0 ? Array.from(sceneTagTokens).join(" ") : null;
  const pickNonEmpty = (v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t !== "" ? t : null;
  };
  const ocrValue = pickNonEmpty(media.ai_ocr);

  return {
    media,
    fields: {
      description: descriptionText,
      keywords: keywordsText,
      subject_tags: subjectTagsText,
      action_tags: actionTagsText,
      scene_tags: sceneTagsText,
      ocr: ocrValue,
    },
  };
}

function replaceMediaSearchTermsForDocument({ mediaId, userId, fields, updatedAt }) {
  db.prepare("DELETE FROM media_search_terms WHERE media_id = ?").run(mediaId);
  const rows = buildMediaSearchTermRows({ mediaId, userId, fields, updatedAt });
  if (rows.length === 0) {
    return 0;
  }
  const insertStmt = db.prepare(`
    INSERT INTO media_search_terms (
      media_id, user_id, field_type, term, term_len, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insertStmt.run(row.mediaId, row.userId, row.fieldType, row.term, row.termLen, row.updatedAt);
  }
  return rows.length;
}

/**
 * 将 media_search 当前行同步到 media_search_fts。不使用 SQL 触发器：SQLite 对 media_search 的 UPDATE
 * 若在触发器内写 FTS，会报 unsafe use of virtual table（驱动侧常显示为 database disk image is malformed）。
 */
function syncMediaSearchFtsRow(mediaId) {
  const row = db
    .prepare(
      `
      SELECT media_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
             caption_search_terms
      FROM media_search WHERE media_id = ?
    `,
    )
    .get(mediaId);
  db.prepare("DELETE FROM media_search_fts WHERE rowid = ?").run(mediaId);
  if (!row) return;
  db.prepare(
    `
    INSERT INTO media_search_fts(
      rowid, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
      caption_search_terms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    row.media_id,
    row.description_text,
    row.keywords_text,
    row.subject_tags_text,
    row.action_tags_text,
    row.scene_tags_text,
    row.caption_search_terms,
  );
}

function rebuildMediaSearchDoc(mediaId) {
  const doc = collectMediaSearchDocument(mediaId);
  if (!doc) return { affectedRows: 0, termRows: 0 };
  const { media, fields } = doc;
  const updatedAt = Date.now();

  if (media.deleted_at != null) {
    db.prepare("DELETE FROM media_search_fts WHERE rowid = ?").run(mediaId);
    const deleted = db.prepare("DELETE FROM media_search WHERE media_id = ?").run(mediaId);
    db.prepare("DELETE FROM media_search_terms WHERE media_id = ?").run(mediaId);
    deleteMediaEmbeddingBySourceType({
      mediaId,
      sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.VISUAL_TEXT,
    });
    clearSearchRankCache();
    return { affectedRows: deleted.changes, termRows: 0 };
  }

  const searchTermsText = buildSearchTermsFromFields(fields);

  const upsert = db.prepare(`
    INSERT INTO media_search (
      media_id, user_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
      ocr_text, caption_search_terms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      user_id = excluded.user_id,
      description_text = excluded.description_text,
      keywords_text = excluded.keywords_text,
      subject_tags_text = excluded.subject_tags_text,
      action_tags_text = excluded.action_tags_text,
      scene_tags_text = excluded.scene_tags_text,
      ocr_text = excluded.ocr_text,
      caption_search_terms = excluded.caption_search_terms,
      updated_at = excluded.updated_at
  `);

  const result = upsert.run(
    media.id,
    media.user_id,
    fields.description,
    fields.keywords,
    fields.subject_tags,
    fields.action_tags,
    fields.scene_tags,
    fields.ocr,
    searchTermsText,
    updatedAt,
  );

  const { ocr: _ocrSkipTerms, ...fieldsWithoutOcrForTerms } = fields;
  const termRows = replaceMediaSearchTermsForDocument({
    mediaId: media.id,
    userId: media.user_id,
    fields: fieldsWithoutOcrForTerms,
    updatedAt,
  });

  syncMediaSearchFtsRow(media.id);
  Promise.resolve(rebuildMediaEmbeddingDoc(media.id)).catch((error) => {
    console.warn("[rebuildMediaSearchDoc] rebuildMediaEmbeddingDoc failed:", error?.message || error);
  });

  clearSearchRankCache();
  return { affectedRows: result.changes, termRows };
}

//保存用户上传的图片元数据到数据库（初始上传时的必要字段）
function insertMedia({ userId, imageHash, thumbnailStorageKey, fileSizeBytes, mediaType, originalStorageKey }) {
  const now = Date.now();
  const normalizedType = mediaType === "video" ? "video" : "image";
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO media (
      user_id,
      file_hash,
      created_at,
      thumbnail_storage_key,
      file_size_bytes,
      media_type,
      original_storage_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(userId, imageHash, now, thumbnailStorageKey || null, fileSizeBytes || null, normalizedType, originalStorageKey || null);

  return { affectedRows: result.changes };
}

// 获取用户所有图片hash
function selectHashesByUserId(userId) {
  const stmt = db.prepare(`SELECT file_hash FROM media WHERE user_id = ? AND deleted_at IS NULL`).pluck();
  return stmt.all(userId);
}

// 分页获取用户具体某年份的图片数据 —— 基于物化的 yearKey
// albumId: 对于时间相册，实际上是 year_key (如 "2024")
// 支持可选的 clusterId 参数，用于查询特定人物的某年份照片
function selectMediasByYear({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  const offset = (pageNo - 1) * pageSize;

  // 如果指定了 clusterId，需要通过 face_clusters 表关联查询
  if (clusterId !== null && clusterId !== undefined) {
    // 使用 JOIN + GROUP BY 确保每张照片只返回一次，性能更好
    // 如果一张图片中有多个人脸都属于同一 cluster，使用 MIN 取第一个 face_embedding_id
    const dataQuery = db.prepare(`
      SELECT 
        i.id,
        i.high_res_storage_key, 
        i.thumbnail_storage_key, 
        i.original_storage_key,
        i.media_type,
        i.duration_sec,
        i.captured_at, 
        i.date_key, 
        i.day_key, 
        i.month_key, 
        i.year_key, 
        i.gps_location,
        i.width_px,
        i.height_px,
        i.aspect_ratio,
        i.layout_type,
        i.file_size_bytes,
        i.face_count,
        i.person_count,
        i.age_tags,
        i.expression_tags,
        i.is_favorite,
        MIN(fe.id) AS face_embedding_id
      FROM media i
      INNER JOIN media_face_embeddings fe ON i.id = fe.media_id
      INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
      WHERE i.user_id = ?
        AND i.year_key = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
      GROUP BY i.id
      ORDER BY i.captured_at DESC, i.id DESC
      LIMIT ? OFFSET ?
    `);

    const countQuery = db.prepare(`
      SELECT COUNT(DISTINCT i.id) AS total
      FROM media i
      INNER JOIN media_face_embeddings fe ON i.id = fe.media_id
      INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
      WHERE i.user_id = ?
        AND i.year_key = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
    `);

    try {
      const data = dataQuery.all(userId, albumId, clusterId, pageSize, offset);
      const { total } = countQuery.get(userId, albumId, clusterId);
      return { data: mapFields("media", data), total };
    } catch (error) {
      throw error;
    }
  } else {
    // 原有逻辑：查询所有用户的某年份图片
    const dataQuery = db.prepare(`
      SELECT 
        id,
        high_res_storage_key, 
        thumbnail_storage_key, 
        original_storage_key,
        media_type,
        duration_sec,
        captured_at, 
        date_key, 
        day_key, 
        month_key, 
        year_key, 
        gps_location,
        width_px,
        height_px,
        aspect_ratio,
        layout_type,
        file_size_bytes,
        face_count,
        person_count,
        age_tags,
        expression_tags,
        is_favorite
      FROM media
      WHERE user_id = ?
        AND year_key = ?
        AND deleted_at IS NULL
      ORDER BY COALESCE(captured_at, 0) DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    const countQuery = db.prepare(`
      SELECT COUNT(*) AS total
      FROM media
      WHERE user_id = ?
        AND year_key = ?
        AND deleted_at IS NULL
    `);

    try {
      const data = dataQuery.all(userId, albumId, pageSize, offset);
      const { total } = countQuery.get(userId, albumId);
      return { data: mapFields("media", data), total };
    } catch (error) {
      throw error;
    }
  }
}

// 分页获取用户具体某月份的图片数据 —— 基于物化的 monthKey
// albumId: 对于时间相册，实际上是 month_key (如 "2024-01")
// 支持可选的 clusterId 参数，用于查询特定人物的某月份照片
function selectMediasByMonth({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  const offset = (pageNo - 1) * pageSize;

  // 如果指定了 clusterId，需要通过 face_clusters 表关联查询
  if (clusterId !== null && clusterId !== undefined) {
    // 使用 JOIN + GROUP BY 确保每张照片只返回一次，性能更好
    // 如果一张图片中有多个人脸都属于同一 cluster，使用 MIN 取第一个 face_embedding_id
    const dataQuery = db.prepare(`
      SELECT 
        i.id,
        i.high_res_storage_key, 
        i.thumbnail_storage_key, 
        i.original_storage_key,
        i.media_type,
        i.duration_sec,
        i.captured_at, 
        i.date_key, 
        i.day_key, 
        i.month_key, 
        i.year_key, 
        i.gps_location,
        i.width_px,
        i.height_px,
        i.aspect_ratio,
        i.layout_type,
        i.file_size_bytes,
        i.face_count,
        i.person_count,
        i.age_tags,
        i.expression_tags,
        i.is_favorite,
        MIN(fe.id) AS face_embedding_id
      FROM media i
      INNER JOIN media_face_embeddings fe ON i.id = fe.media_id
      INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
      WHERE i.user_id = ?
        AND i.month_key = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
      GROUP BY i.id
      ORDER BY i.captured_at DESC, i.id DESC
      LIMIT ? OFFSET ?
    `);

    const countQuery = db.prepare(`
      SELECT COUNT(DISTINCT i.id) AS total
      FROM media i
      INNER JOIN media_face_embeddings fe ON i.id = fe.media_id
      INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
      WHERE i.user_id = ?
        AND i.month_key = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
    `);

    try {
      const data = dataQuery.all(userId, albumId, clusterId, pageSize, offset);
      const { total } = countQuery.get(userId, albumId, clusterId);
      return { data: mapFields("media", data), total };
    } catch (error) {
      throw error;
    }
  } else {
    // 原有逻辑：查询所有用户的某月份图片
    const dataQuery = db.prepare(`
      SELECT 
        id,
        high_res_storage_key, 
        thumbnail_storage_key, 
        original_storage_key,
        media_type,
        duration_sec,
        captured_at, 
        date_key, 
        day_key, 
        month_key, 
        year_key, 
        gps_location,
        width_px,
        height_px,
        aspect_ratio,
        layout_type,
        file_size_bytes,
        face_count,
        person_count,
        age_tags,
        expression_tags,
        is_favorite
      FROM media
      WHERE user_id = ?
        AND month_key = ?
        AND deleted_at IS NULL
      ORDER BY COALESCE(captured_at, 0) DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    const countQuery = db.prepare(`
      SELECT COUNT(*) AS total
      FROM media
      WHERE user_id = ?
        AND month_key = ?
        AND deleted_at IS NULL
    `);

    try {
      const data = dataQuery.all(userId, albumId, pageSize, offset);
      const { total } = countQuery.get(userId, albumId);
      return { data: mapFields("media", data), total };
    } catch (error) {
      throw error;
    }
  }
}

// 分页获取用户具体某个日期的图片数据 —— 基于物化的 dateKey
// albumId: 对于时间相册，实际上是 date_key (如 "2024-01-15")
function selectMediasByDate({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT 
      id,
      high_res_storage_key, 
      thumbnail_storage_key, 
      original_storage_key,
      media_type,
      duration_sec,
      captured_at, 
      date_key, 
      day_key, 
      month_key, 
      year_key, 
      gps_location,
      width_px,
      height_px,
      aspect_ratio,
        layout_type,
        file_size_bytes,
      face_count,
      person_count,
      age_tags,
      expression_tags,
      is_favorite
    FROM media
    WHERE user_id = ?
      AND date_key = ?
      AND deleted_at IS NULL
    ORDER BY COALESCE(captured_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media
    WHERE user_id = ?
      AND date_key = ?
      AND deleted_at IS NULL
  `);

  try {
    const data = dataQuery.all(userId, albumId, pageSize, offset);
    const { total } = countQuery.get(userId, albumId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

/**
 * 分页获取用户模糊图列表（is_blurry = 1）
 */
function getMediasByBlurry({ userId, pageNo, pageSize }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    SELECT
      id,
      high_res_storage_key,
      thumbnail_storage_key,
      captured_at,
      created_at,
      date_key,
      day_key,
      month_key,
      year_key,
      gps_location,
      width_px,
      height_px,
      aspect_ratio,
        layout_type,
        file_size_bytes,
      face_count,
      person_count,
      age_tags,
      expression_tags,
      is_favorite
    FROM media
    WHERE user_id = ?
      AND is_blurry = 1
      AND deleted_at IS NULL
    ORDER BY sharpness_score ASC, id ASC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media
    WHERE user_id = ?
      AND is_blurry = 1
      AND deleted_at IS NULL
  `);

  try {
    const data = dataQuery.all(userId, pageSize, offset);
    const { total } = countQuery.get(userId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

/**
 * 按用户更新模糊图标记（分组重建时调用）
 * @param {number} userId
 * @param {number[]} blurryImageIds - 当前应标记为模糊的图片 ID 列表
 */
function updateBlurryForUser(userId, blurryImageIds) {
  if (!userId) return;
  const idsSet = blurryImageIds && blurryImageIds.length > 0 ? blurryImageIds : [];
  const placeholders = idsSet.length > 0 ? idsSet.map(() => "?").join(", ") : "";

  const markBlurry =
    idsSet.length > 0
      ? db.prepare(`
        UPDATE media
        SET is_blurry = 1
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
      `)
      : null;

  const clearBlurrySql =
    idsSet.length > 0
      ? `
        UPDATE media
        SET is_blurry = 0
        WHERE user_id = ? AND deleted_at IS NULL
          AND id NOT IN (${placeholders})
      `
      : `
        UPDATE media
        SET is_blurry = 0
        WHERE user_id = ? AND deleted_at IS NULL
      `;
  const clearBlurry = db.prepare(clearBlurrySql);

  if (markBlurry) markBlurry.run(userId, ...idsSet);
  if (idsSet.length > 0) {
    clearBlurry.run(userId, ...idsSet);
  } else {
    clearBlurry.run(userId);
  }
}

// 分页获取用户按月分组（YYYY-MM / 'unknown'）数据 —— 基于物化 monthKey
// 🎯 功能：按月分组显示相册封面，智能选择最开心最清晰的照片作为封面
function selectGroupsByMonth({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH ranked_images AS (
      -- 为所有图片按月份分组并排序，使用窗口函数避免N+1查询
      SELECT 
        month_key,
        expression_tags,
        face_count,
        person_count,
        preferred_face_quality,
        thumbnail_storage_key,
        captured_at,
        id,
        ROW_NUMBER() OVER (
          PARTITION BY month_key 
          ORDER BY 
            -- 🥰 封面选择策略：情绪优先 + 清晰度优先
            -- 1. happy 且有人脸
            -- 2. neutral 且有人脸（但没有 happy）
            -- 3. 其他有人脸
            -- 4. 有人物但无人脸
            -- 5. 其余兜底（未分析/无人）
            CASE 
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,happy,%')
                   THEN 1
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
                   THEN 2
              WHEN face_count > 0 THEN 3
              WHEN person_count > 0 THEN 4
              ELSE 5
            END,
            -- 🔢 同优先级内的精细排序：
            COALESCE(preferred_face_quality, 0) DESC,
            COALESCE(face_count, 0) DESC,
            COALESCE(person_count, 0) DESC,
            COALESCE(captured_at, 0) DESC,
            id DESC
        ) AS rn
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND month_key != 'unknown'
        AND (COALESCE(media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    latest AS (
      -- 选择每个月份的第一张图片作为封面（排除音频，音频无缩略图）
      SELECT 
        month_key,
        thumbnail_storage_key,
        captured_at,
        id
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      -- 📊 统计每个月份的照片数量（排除 unknown）
      SELECT month_key, COUNT(*) AS imageCount
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND month_key != 'unknown'
      GROUP BY month_key
    )
    SELECT
      latest.month_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.month_key = latest.month_key
    ORDER BY latest.month_key DESC
    LIMIT ? OFFSET ?;
  `);

  // 📊 组总数：排除 unknown
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT month_key) AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND month_key != 'unknown';
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按年分组（YYYY，排除 unknown）数据 —— 基于物化 yearKey
function selectGroupsByYear({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH ranked_images AS (
      -- 为所有图片按年份分组并排序，使用窗口函数避免N+1查询
      SELECT 
        year_key,
        expression_tags,
        face_count,
        person_count,
        preferred_face_quality,
        thumbnail_storage_key,
        captured_at,
        id,
        ROW_NUMBER() OVER (
          PARTITION BY year_key 
          ORDER BY 
            -- 🥰 封面选择策略：情绪优先 + 清晰度优先
            CASE 
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,happy,%')
                   THEN 1
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
                   THEN 2
              WHEN face_count > 0 THEN 3
              WHEN person_count > 0 THEN 4
              ELSE 5
            END,
            COALESCE(preferred_face_quality, 0) DESC,
            COALESCE(face_count, 0) DESC,
            COALESCE(person_count, 0) DESC,
            COALESCE(captured_at, 0) DESC,
            id DESC
        ) AS rn
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND year_key != 'unknown'
        AND (COALESCE(media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    latest AS (
      -- 选择每个年份的第一张图片作为封面（排除音频）
      SELECT 
        year_key,
        thumbnail_storage_key,
        captured_at,
        id
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      -- 统计每个年份的图片数量（排除 unknown）
      SELECT year_key, COUNT(*) AS imageCount
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND year_key != 'unknown'
      GROUP BY year_key
    )
    SELECT
      latest.year_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.year_key = latest.year_key
    ORDER BY latest.year_key DESC
    LIMIT ? OFFSET ?;
  `);

  // 组总数：排除 unknown
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT year_key) AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND year_key != 'unknown';
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取指定人物（clusterId）按年份分组的数据
function selectGroupsByYearForCluster({ pageNo, pageSize, userId, clusterId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH ranked_images AS (
      -- 为指定人物的图片按年份分组并排序
      SELECT 
        i.year_key,
        i.expression_tags,
        i.face_count,
        i.person_count,
        i.preferred_face_quality,
        i.thumbnail_storage_key,
        i.captured_at,
        i.id,
        ROW_NUMBER() OVER (
          PARTITION BY i.year_key 
          ORDER BY 
            CASE 
              WHEN i.face_count > 0
                   AND ((',' || REPLACE(COALESCE(i.expression_tags,''),' ','') || ',') LIKE '%,happy,%')
                   THEN 1
              WHEN i.face_count > 0
                   AND ((',' || REPLACE(COALESCE(i.expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
                   AND ((',' || REPLACE(COALESCE(i.expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
                   THEN 2
              WHEN i.face_count > 0 THEN 3
              WHEN i.person_count > 0 THEN 4
              ELSE 5
            END,
            COALESCE(i.preferred_face_quality, 0) DESC,
            COALESCE(i.face_count, 0) DESC,
            COALESCE(i.person_count, 0) DESC,
            COALESCE(i.captured_at, 0) DESC,
            i.id DESC
        ) AS rn
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media i ON fe.media_id = i.id
      WHERE fc.user_id = ? 
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
        AND (COALESCE(i.media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    latest AS (
      SELECT 
        year_key,
        thumbnail_storage_key,
        captured_at,
        id
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      SELECT i.year_key, COUNT(DISTINCT i.id) AS imageCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media i ON fe.media_id = i.id
      WHERE fc.user_id = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
      GROUP BY i.year_key
    )
    SELECT
      latest.year_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.year_key = latest.year_key
    ORDER BY
      CASE WHEN latest.year_key = 'unknown' THEN 1 ELSE 0 END,
      latest.year_key DESC
    LIMIT ? OFFSET ?;
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT i.year_key) AS groupCount
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media i ON fe.media_id = i.id
      WHERE fc.user_id = ?
      AND fc.cluster_id = ?
      AND i.deleted_at IS NULL;
  `);

  try {
    const data = dataQuery.all(userId, clusterId, userId, clusterId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId, clusterId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取指定人物（clusterId）按月份分组的数据
function selectGroupsByMonthForCluster({ pageNo, pageSize, userId, clusterId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH ranked_images AS (
      -- 为指定人物的图片按月份分组并排序
      SELECT 
        i.month_key,
        i.expression_tags,
        i.face_count,
        i.person_count,
        i.preferred_face_quality,
        i.thumbnail_storage_key,
        i.captured_at,
        i.id,
        ROW_NUMBER() OVER (
          PARTITION BY i.month_key 
          ORDER BY 
            CASE 
              WHEN i.face_count > 0
                   AND ((',' || REPLACE(COALESCE(i.expression_tags,''),' ','') || ',') LIKE '%,happy,%')
                   THEN 1
              WHEN i.face_count > 0
                   AND ((',' || REPLACE(COALESCE(i.expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
                   AND ((',' || REPLACE(COALESCE(i.expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
                   THEN 2
              WHEN i.face_count > 0 THEN 3
              WHEN i.person_count > 0 THEN 4
              ELSE 5
            END,
            COALESCE(i.preferred_face_quality, 0) DESC,
            COALESCE(i.face_count, 0) DESC,
            COALESCE(i.person_count, 0) DESC,
            COALESCE(i.captured_at, 0) DESC,
            i.id DESC
        ) AS rn
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media i ON fe.media_id = i.id
      WHERE fc.user_id = ? 
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
        AND (COALESCE(i.media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    latest AS (
      SELECT 
        month_key,
        thumbnail_storage_key,
        captured_at,
        id
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      SELECT i.month_key, COUNT(DISTINCT i.id) AS imageCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media i ON fe.media_id = i.id
      WHERE fc.user_id = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
      GROUP BY i.month_key
    )
    SELECT
      latest.month_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.month_key = latest.month_key
    ORDER BY
      CASE WHEN latest.month_key = 'unknown' THEN 1 ELSE 0 END,
      latest.month_key DESC
    LIMIT ? OFFSET ?;
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT i.month_key) AS groupCount
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media i ON fe.media_id = i.id
      WHERE fc.user_id = ?
      AND fc.cluster_id = ?
      AND i.deleted_at IS NULL;
  `);

  try {
    const data = dataQuery.all(userId, clusterId, userId, clusterId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId, clusterId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按日期分组（YYYY-MM-DD / 'unknown'）数据 —— 基于物化 dateKey
function selectGroupsByDate({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH ranked_images AS (
      -- 为所有图片按日期分组并排序，使用窗口函数避免N+1查询
      SELECT 
        date_key,
        expression_tags,
        face_count,
        person_count,
        preferred_face_quality,
        thumbnail_storage_key,
        captured_at,
        id,
        ROW_NUMBER() OVER (
          PARTITION BY date_key 
          ORDER BY 
            -- 🥰 封面选择策略：情绪优先 + 清晰度优先
            CASE 
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,happy,%')
                   THEN 1
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
                   THEN 2
              WHEN face_count > 0 THEN 3
              WHEN person_count > 0 THEN 4
              ELSE 5
            END,
            COALESCE(preferred_face_quality, 0) DESC,
            COALESCE(face_count, 0) DESC,
            COALESCE(person_count, 0) DESC,
            COALESCE(captured_at, 0) DESC,
            id DESC
        ) AS rn
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND (COALESCE(media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    latest AS (
      -- 选择每个日期的第一张媒体作为封面（含图片/视频/音频）
      SELECT 
        date_key,
        thumbnail_storage_key,
        captured_at,
        id
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      -- 统计每个日期的图片数量
      SELECT date_key, COUNT(*) AS imageCount
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
      GROUP BY date_key
    )
    SELECT
      latest.date_key AS album_id,  -- 相册ID（统一使用 album_id，mapper 会映射为 albumId）
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
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
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL;
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户按地点分组的数据（优先 city，否则 country；均无则为 unknown）
function selectGroupsByCity({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const albumKey = sqlLocationAlbumKey("m");

  const dataQuery = db.prepare(`
    WITH city_normalized AS (
      SELECT 
        m.id,
        ${albumKey} AS city_key,
        m.expression_tags,
        m.face_count,
        m.person_count,
        m.preferred_face_quality,
        m.thumbnail_storage_key,
        m.captured_at
      FROM media AS m
      WHERE m.user_id = ? AND m.deleted_at IS NULL
        AND (COALESCE(m.media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    ranked_images AS (
      SELECT 
        city_key,
        thumbnail_storage_key,
        captured_at,
        id,
        ROW_NUMBER() OVER (
          PARTITION BY city_key 
          ORDER BY 
            CASE 
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,happy,%')
                   THEN 1
              WHEN face_count > 0
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
                   AND ((',' || REPLACE(COALESCE(expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
                   THEN 2
              WHEN face_count > 0 THEN 3
              WHEN person_count > 0 THEN 4
              ELSE 5
            END,
            COALESCE(preferred_face_quality, 0) DESC,
            COALESCE(face_count, 0) DESC,
            COALESCE(person_count, 0) DESC,
            COALESCE(captured_at, 0) DESC,
            id DESC
        ) AS rn
      FROM city_normalized
    ),
    latest AS (
      SELECT city_key, thumbnail_storage_key, captured_at, id
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      SELECT city_key, COUNT(*) AS imageCount
      FROM city_normalized
      GROUP BY city_key
    )
    SELECT
      latest.city_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.city_key = latest.city_key
    ORDER BY
      CASE WHEN latest.city_key = 'unknown' THEN 1 ELSE 0 END,
      counts.imageCount DESC,
      latest.city_key ASC
    LIMIT ? OFFSET ?;
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT ${albumKey}) AS groupCount
    FROM media AS m
    WHERE m.user_id = ? AND m.deleted_at IS NULL
      AND (COALESCE(m.media_type, 'image') IN ('image', 'video', 'audio'));
  `);

  try {
    const data = dataQuery.all(userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户具体某个地点的图片数据
// albumId: 地点键（优先 city，否则 country）或 'unknown'
function selectMediasByCity({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const isUnknown = albumId === "unknown";
  const locKey = sqlLocationKeyNullable("m");

  const baseSelect = `
    SELECT 
      m.id,
      m.high_res_storage_key, 
      m.thumbnail_storage_key, 
      m.original_storage_key,
      m.media_type,
      m.duration_sec,
      m.captured_at, 
      m.date_key, 
      m.day_key, 
      m.month_key, 
      m.year_key, 
      m.gps_location,
      m.width_px,
      m.height_px,
      m.aspect_ratio,
        m.layout_type,
        m.file_size_bytes,
      m.face_count,
      m.person_count,
      m.age_tags,
      m.expression_tags,
      m.is_favorite
    FROM media AS m
    WHERE m.user_id = ? AND m.deleted_at IS NULL
  `;
  const cityCondition = isUnknown ? ` AND ${sqlLocationIsUnknown("m")}` : ` AND (${locKey}) = ?`;
  const orderLimit = " ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC LIMIT ? OFFSET ?";

  const dataQuery = db.prepare(baseSelect + cityCondition + orderLimit);
  const countQuery = db.prepare(
    "SELECT COUNT(*) AS total FROM media AS m WHERE m.user_id = ? AND m.deleted_at IS NULL" + cityCondition,
  );

  try {
    const params = isUnknown ? [userId, pageSize, offset] : [userId, albumId, pageSize, offset];
    const countParams = isUnknown ? [userId] : [userId, albumId];
    const data = dataQuery.all(...params);
    const { total } = countQuery.get(...countParams);
    return { data: mapFields("media", data), total };
  } catch (error) {
    throw error;
  }
}

// 更新图片元数据（EXIF、GPS、尺寸、存储键等）
function updateMediaMetadata({
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
  province,
  city,
  widthPx,
  heightPx,
  aspectRatio,
  rawOrientation,
  layoutType,
  hdWidthPx,
  hdHeightPx,
  mime,
  durationSec,
  videoCodec,
  mediaType,
  mapRegeoStatus,
}) {
  const mapRegeoClause = mapRegeoStatus !== undefined ? ", map_regeo_status = ?" : "";
  const sql = `
    UPDATE media SET
      captured_at = COALESCE(?, captured_at),
      month_key = COALESCE(?, month_key),
      year_key = COALESCE(?, year_key),
      date_key = COALESCE(?, date_key),
      day_key = COALESCE(?, day_key),
      high_res_storage_key = COALESCE(?, high_res_storage_key),
      original_storage_key = COALESCE(?, original_storage_key),
      gps_latitude = COALESCE(?, gps_latitude),
      gps_longitude = COALESCE(?, gps_longitude),
      gps_altitude = COALESCE(?, gps_altitude),
      gps_location = COALESCE(?, gps_location),
      country = COALESCE(?, country),
      province = COALESCE(?, province),
      city = COALESCE(?, city),
      width_px = COALESCE(?, width_px),
      height_px = COALESCE(?, height_px),
      aspect_ratio = COALESCE(?, aspect_ratio),
      raw_orientation = COALESCE(?, raw_orientation),
      layout_type = COALESCE(?, layout_type),
      hd_width_px = COALESCE(?, hd_width_px),
      hd_height_px = COALESCE(?, hd_height_px),
      mime = COALESCE(?, mime),
      duration_sec = COALESCE(?, duration_sec),
      video_codec = COALESCE(?, video_codec),
      media_type = COALESCE(?, media_type)${mapRegeoClause},
      meta_pipeline_status = 'success'
    WHERE user_id = ? AND file_hash = ? RETURNING id
  `;

  const stmt = db.prepare(sql);
  const params = [
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
    province,
    city,
    widthPx,
    heightPx,
    aspectRatio,
    rawOrientation,
    layoutType,
    hdWidthPx,
    hdHeightPx,
    mime,
    durationSec,
    videoCodec,
    mediaType,
  ];
  if (mapRegeoStatus !== undefined) {
    params.push(mapRegeoStatus);
  }
  params.push(userId, imageHash);

  const result = stmt.get(...params);

  return {
    affectedRows: result ? 1 : 0,
    imageId: result?.id || null,
  };
}

/** 按用户 + file_hash 查一行（含回收站），用于预检是否仅命中软删记录 */
function selectMediaRowByHashForUser({ userId, imageHash }) {
  const stmt = db.prepare(`
    SELECT id, deleted_at
    FROM media
    WHERE user_id = ? AND file_hash = ?
    LIMIT 1
  `);
  return stmt.get(userId, imageHash);
}

// 异步更新图片位置信息
function updateLocationInfo(imageId, { gpsLocation, country, province, city, mapRegeoStatus }, options = {}) {
  const { rebuildSearchArtifacts = false } = options;
  const mapClause = mapRegeoStatus !== undefined ? ", map_regeo_status = ?" : "";
  const sql = `
    UPDATE media SET
      gps_location = COALESCE(?, gps_location),
      country = COALESCE(?, country),
      province = COALESCE(?, province),
      city = COALESCE(?, city)${mapClause}
    WHERE id = ?
  `;

  const stmt = db.prepare(sql);
  const locParams = [gpsLocation, country, province, city];
  if (mapRegeoStatus !== undefined) {
    locParams.push(mapRegeoStatus);
  }
  locParams.push(imageId);
  const result = stmt.run(...locParams);

  if (rebuildSearchArtifacts) {
    rebuildMediaSearchDoc(imageId);
  }
  return { affectedRows: result.changes };
}

/** meta 流水线终态：仅 success | failed；空值与非法字符串不执行 UPDATE。 */
function updateMetaPipelineStatusByHash({ userId, imageHash, metaPipelineStatus }) {
  if (!userId || !imageHash) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed"]);
  if (metaPipelineStatus == null || !allowed.has(metaPipelineStatus)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET meta_pipeline_status = ?
      WHERE user_id = ? AND file_hash = ?
    `,
    )
    .run(metaPipelineStatus, userId, imageHash);
  return { affectedRows: result.changes };
}

/** 本地智能分析阶段终态：success | failed；进行中不写库（由 Bull 队列体现）。非法 status 不执行 UPDATE。 */
function updateAnalysisStatusPrimary(mediaId, status) {
  if (!mediaId) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed"]);
  if (!allowed.has(status)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET analysis_status_primary = ?
      WHERE id = ?
    `,
    )
    .run(status, mediaId);
  return { affectedRows: result.changes };
}

/**
 * 云分析结果落库：仅接受 success | failed | skipped；非法 status 不执行 UPDATE。
 * 新行未写该列时为 NULL；终态由主流程/异步队列写入。
 */
function updateAnalysisStatusCloud(mediaId, status) {
  if (!mediaId) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed", "skipped"]);
  if (!allowed.has(status)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET analysis_status_cloud = ?
      WHERE id = ?
    `,
    )
    .run(status, mediaId);
  return { affectedRows: result.changes };
}

/** 线上地图逆地理终态：success | failed | skipped；非法不 UPDATE。 */
function updateMapRegeoStatus(mediaId, status) {
  if (!mediaId) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed", "skipped"]);
  if (!allowed.has(status)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET map_regeo_status = ?
      WHERE id = ?
    `,
    )
    .run(status, mediaId);
  return { affectedRows: result.changes };
}

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
 * 云阶段失败媒体一次性列出（处理中心重试：先缓存再分批入队，避免多次分页查库）。
 * @param {{ userId: number, mediaIds?: number[]|null, maxRows?: number }} args
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
 * 当前用户各阶段处理失败条数（未删除媒体），用于处理中心汇总展示。
 * @param {number} userId
 * @param {{ includeCloudFailures?: boolean }} [options] 为 false 时不统计云端失败（与 total 中不含 cloud）
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
 * 历史补跑批次：仅 skipped；失败请在处理中心重试。
 * @param {number|null|undefined} cursorBeforeId 上一批最后一条的 id（本批取 `id < cursorBeforeId`），避免同一次全量入队重复选中同一批。
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
 * 👤 插入人脸特征向量数据到face_embeddings表
 *
 * 功能说明:
 * • 存储图片中每个人脸的详细信息和512维特征向量
 * • 支持人脸识别、聚类、相似度计算
 * • 采用先删除再插入策略，保证数据一致性
 * • 存储人脸缩略图（用于封面显示）
 *
 * @function insertFaceEmbeddings
 * @param {number} imageId - 图片ID
 * @param {Array<Object>} faceData - 人脸数据数组
 * @param {number} faceData[].face_index - 人脸序号（同一张图片中的第几个人脸）
 * @param {Array<number>} faceData[].embedding - 512维特征向量（InsightFace提取）
 * @param {number} faceData[].age - 年龄段中间值（用于数值计算）如：25代表20-29岁段
 * @param {string} faceData[].gender - 性别："male" 或 "female"
 * @param {string} faceData[].expression - 表情："happy", "neutral", "sad"等
 * @param {number} faceData[].confidence - 人脸检测置信度 (0-1)
 * @param {string} [faceData[].face_thumbnail_base64] - 人脸缩略图base64编码（可选）
 *
 * @returns {Promise<Object>} 返回对象 { affectedRows: 插入的行数 }
 *
 * 📊 数据用途:
 * • 人脸识别：通过embedding计算余弦相似度
 * • 人脸聚类：将相似人脸分组（同一个人）
 * • 人物搜索：按年龄、性别、表情筛选人脸
 * • 人物相册：按聚类ID查看某个人的所有照片
 *
 * 🔄 处理策略:
 * 1. 先删除该图片的旧人脸数据（避免重复）
 * 2. 批量插入新的人脸数据
 * 3. embedding存储为BLOB（JSON序列化后的512维数组）
 * 4. 如果提供face_thumbnail_base64，则存储人脸缩略图
 *
 * ⚠️ 注意事项:
 * • embedding是512维float数组，需要JSON.stringify后存储
 * • age字段存储的是年龄段中间值，不是age_bucket字符串
 * • 如果faceData为空，只执行删除操作
 * • 重复调用会覆盖旧数据（幂等性）
 *
 * 💡 使用示例:
 * ```javascript
 * const faces = [
 *   {
 *     face_index: 0,
 *     embedding: [...512维数组...],
 *     age: 25,  // 代表20-29岁段
 *     gender: 'female',
 *     expression: 'happy',
 *     confidence: 0.95,
 *     face_thumbnail_base64: 'data:image/jpeg;base64,...'
 *   }
 * ];
 * await insertFaceEmbeddings(imageId, faces);
 * ```
 */
async function insertFaceEmbeddings(imageId, faceData, options = {}) {
  try {
    const sourceType = options.sourceType === "video" ? "video" : "image";
    const deleteSql = `DELETE FROM media_face_embeddings WHERE media_id = ? AND source_type = ?`;
    const deleteStmt = db.prepare(deleteSql);
    deleteStmt.run(imageId, sourceType);

    if (!faceData || faceData.length === 0) {
      return { affectedRows: 0 };
    }

    // 批量插入新的人脸数据
    // 优化（2025-12-XX）：添加quality_score、bbox、pose字段，移除face_thumbnail_storage_key处理
    // 缩略图将在聚类后，只为最佳人脸生成
    const insertSql = `
      INSERT INTO media_face_embeddings (
        media_id, source_type, face_index, embedding, age, gender, expression, confidence, quality_score, bbox, pose
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const insertStmt = db.prepare(insertSql);

    let totalAffected = 0;
    for (const face of faceData) {
      // 将embedding数组转换为Buffer存储
      const embeddingBuffer = Buffer.from(JSON.stringify(face.embedding));

      const result = insertStmt.run(
        imageId,
        sourceType,
        face.face_index,
        embeddingBuffer,
        face.age || null,
        face.gender || null,
        face.expression || null,
        face.confidence || null,
        face.quality_score || null,
        JSON.stringify(face.bbox || []), // bbox存储为JSON字符串
        JSON.stringify(face.pose || {}), // pose存储为JSON字符串
      );
      totalAffected += result.changes;
    }

    return { affectedRows: totalAffected };
  } catch (error) {
    console.error("插入人脸特征向量失败:", error);
    throw error;
  }
}

/**
 * 根据ID获取图片存储信息（用于获取封面等场景）
 */
function getMediaStorageInfo(imageId) {
  const sql = `
    SELECT 
      id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key,
      media_type
    FROM media
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `;

  const stmt = db.prepare(sql);
  const image = stmt.get(imageId);

  if (!image) {
    return null;
  }

  return {
    id: image.id,
    thumbnailStorageKey: image.thumbnail_storage_key,
    highResStorageKey: image.high_res_storage_key,
    originalStorageKey: image.original_storage_key,
    mediaType: image.media_type || "image",
  };
}

/**
 * 根据ID获取图片下载信息（包含 original_storage_key，用于下载）
 */
function getMediaDownloadInfo({ userId, imageId }) {
  const sql = `
    SELECT 
      id,
      media_type,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key
    FROM media
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `;

  const stmt = db.prepare(sql);
  const image = stmt.get(imageId, userId);

  if (!image) {
    return null;
  }

  return {
    id: image.id,
    mediaType: image.media_type || "image",
    originalStorageKey: image.original_storage_key,
    highResStorageKey: image.high_res_storage_key,
    thumbnailStorageKey: image.thumbnail_storage_key,
  };
}

/**
 * 批量根据 imageIds 获取图片下载信息（用于批量下载）
 */
function getMediasDownloadInfo({ userId, imageIds }) {
  if (!imageIds || imageIds.length === 0) {
    return [];
  }

  const placeholders = imageIds.map(() => "?").join(",");
  const sql = `
    SELECT 
      id,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key
    FROM media
    WHERE id IN (${placeholders}) AND user_id = ? AND deleted_at IS NULL
  `;

  const stmt = db.prepare(sql);
  const images = stmt.all(...imageIds, userId);

  return images.map((image) => ({
    id: image.id,
    originalStorageKey: image.original_storage_key,
    highResStorageKey: image.high_res_storage_key,
    thumbnailStorageKey: image.thumbnail_storage_key,
  }));
}

/**
 * 媒体分析链路：写入 caption / VLM 结果（含 Python modules.caption → ai_* 文本字段；人脸/人数写入 face_count / person_count）。
 * 仅更新传入的非空字段（caption 为 success 但全空时不写库）。
 * caption 形状：{ description?, keywords?, subjectTags?, actionTags?, sceneTags?, ocr?, faceCount?, personCount? }
 */
function upsertMediaAiFieldsForAnalysis({ mediaId, caption }) {
  if (caption == null) return;

  const assignments = [];
  const params = [];

  if (caption.description !== undefined) {
    assignments.push("ai_description = ?");
    params.push(caption.description);
  }
  if (caption.keywords !== undefined) {
    assignments.push("ai_keywords_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.keywords)));
  }
  if (caption.subjectTags !== undefined) {
    assignments.push("ai_subject_tags_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.subjectTags)));
  }
  if (caption.actionTags !== undefined) {
    assignments.push("ai_action_tags_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.actionTags)));
  }
  if (caption.sceneTags !== undefined) {
    assignments.push("ai_scene_tags_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.sceneTags)));
  }
  if (caption.ocr !== undefined) {
    assignments.push("ai_ocr = ?");
    params.push(caption.ocr);
  }
  if (caption.faceCount !== undefined && caption.faceCount !== null) {
    const fc = typeof caption.faceCount === "number" && Number.isFinite(caption.faceCount) ? Math.max(0, Math.floor(caption.faceCount)) : null;
    if (fc !== null) {
      assignments.push("face_count = ?");
      params.push(fc);
    }
  }
  if (caption.personCount !== undefined && caption.personCount !== null) {
    const pc = typeof caption.personCount === "number" && Number.isFinite(caption.personCount) ? Math.max(0, Math.floor(caption.personCount)) : null;
    if (pc !== null) {
      assignments.push("person_count = ?");
      params.push(pc);
    }
  }

  if (assignments.length === 0) return;
  params.push(mediaId);
  db.prepare(`UPDATE media SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

/** 当前用户下云阶段为 skipped 的媒体条数（未删除） */
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

/** 当前用户 map_regeo_status ∈ {skipped, failed} 且含 GPS（与设置页补跑入队条件一致） */
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
 * 地图逆地理补跑批次：skipped / failed + 有 GPS；入队不改库。
 * @param {number|null|undefined} cursorBeforeId 上一批最后一条 id，本批 `id < cursorBeforeId`
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

/** Worker 校验：指定用户下媒体是否存在、未删 */
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
  sqlLocationKeyNullable,
  sqlLocationIsUnknown,
  normalizeTextArray,
  selectMediaRowByHashForUser,
  insertMedia,
  updateMediaMetadata,
  updateLocationInfo,
  insertFaceEmbeddings,
  selectMediasByYear,
  selectMediasByMonth,
  selectMediasByDate,
  getMediasByBlurry,
  updateBlurryForUser,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectGroupsByDate,
  selectGroupsByCity,
  selectMediasByCity,
  selectGroupsByYearForCluster,
  selectGroupsByMonthForCluster,
  selectHashesByUserId,
  getMediaStorageInfo,
  getMediaDownloadInfo,
  getMediasDownloadInfo,
  rebuildMediaSearchDoc,
  updateMetaPipelineStatusByHash,
  upsertMediaAiFieldsForAnalysis,
  updateAnalysisStatusPrimary,
  updateAnalysisStatusCloud,
  updateMapRegeoStatus,
  listFailedMedias,
  listAllFailedCloudMedias,
  countFailedMediasByStage,
  selectPendingCloudCaptionBatch,
  countCloudAnalysisSkippedForUser,
  countMapRegeoSkippedForUser,
  selectPendingMapRegeoBatch,
  selectMediaRowForMapRegeoJob,
};
