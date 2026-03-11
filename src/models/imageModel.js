/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 15:07:05
 * @Description: File description
 */
const { db } = require("../services/database");
const { mapFields } = require("../utils/fieldMapper");
const { mapObjectLabel } = require("../constants/objectTaxonomy");
const { mapSceneLabel } = require("../constants/sceneTaxonomy");

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

function pickPrimaryTag(input) {
  const arr = parseCommaTags(input);
  return arr.length > 0 ? arr[0] : null;
}

function rebuildMediaSearchDoc(mediaId) {
  const media = db.prepare("SELECT id, user_id, country, city, gps_location, deleted_at FROM media WHERE id = ?").get(mediaId);
  if (!media) return { affectedRows: 0 };

  if (media.deleted_at != null) {
    const deleted = db.prepare("DELETE FROM media_search WHERE media_id = ?").run(mediaId);
    db.prepare("INSERT INTO media_fts(media_fts) VALUES('rebuild')").run();
    return { affectedRows: deleted.changes };
  }

  const captionTextRow = db.prepare("SELECT GROUP_CONCAT(caption, ' ') AS value FROM media_captions WHERE media_id = ?").get(mediaId);
  const ocrTextRow = db.prepare("SELECT GROUP_CONCAT(text, ' ') AS value FROM media_text_blocks WHERE media_id = ?").get(mediaId);

  // 对 object / scene 应用 taxonomy：Raw → Canonical (+中文别名) 文本聚合
  const objectRows = db
    .prepare(
      `
      SELECT DISTINCT label
      FROM media_objects
      WHERE media_id = ?
    `,
    )
    .all(mediaId);
  const objectTokens = new Set();
  for (const row of objectRows) {
    const raw = row.label;
    if (!raw) continue;
    const { canonical, category, zh } = mapObjectLabel(String(raw));
    if (canonical) {
      objectTokens.add(String(canonical));
    }
    if (category) {
      objectTokens.add(String(category));
    }
    if (zh) {
      objectTokens.add(String(zh));
    }
  }
  const objectText = objectTokens.size > 0 ? Array.from(objectTokens).join(" ") : null;

  const sceneRow = db.prepare("SELECT scene_primary AS value FROM media_analysis WHERE media_id = ?").get(mediaId);
  let sceneText = null;
  if (sceneRow && sceneRow.value) {
    const { canonical, zh } = mapSceneLabel(String(sceneRow.value));
    const parts = [];
    if (canonical) parts.push(String(canonical));
    if (zh) parts.push(String(zh));
    sceneText = parts.length > 0 ? parts.join(" ") : null;
  }

  const transcriptTextRow = db
    .prepare("SELECT GROUP_CONCAT(transcript_text, ' ') AS value FROM video_transcripts WHERE media_id = ?")
    .get(mediaId);

  const locationText = [media.country, media.city, media.gps_location].filter(Boolean).join(" ").trim() || null;

  const upsert = db.prepare(`
    INSERT INTO media_search (
      media_id, user_id, caption_text, ocr_text, object_text, scene_text, transcript_text, location_text, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      user_id = excluded.user_id,
      caption_text = excluded.caption_text,
      ocr_text = excluded.ocr_text,
      object_text = excluded.object_text,
      scene_text = excluded.scene_text,
      transcript_text = excluded.transcript_text,
      location_text = excluded.location_text,
      updated_at = excluded.updated_at
  `);

  const result = upsert.run(
    media.id,
    media.user_id,
    captionTextRow?.value || null,
    ocrTextRow?.value || null,
    objectText,
    sceneText,
    transcriptTextRow?.value || null,
    locationText,
    Date.now(),
  );

  db.prepare("INSERT INTO media_fts(media_fts) VALUES('rebuild')").run();
  return { affectedRows: result.changes };
}

//保存用户上传的图片元数据到数据库（初始上传时的必要字段）
function insertImage({ userId, imageHash, thumbnailStorageKey, storageType, fileSizeBytes, mediaType }) {
  const now = Date.now();
  const normalizedType = mediaType === "video" ? "video" : "image";
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO media (
      user_id,
      file_hash,
      created_at,
      thumbnail_storage_key,
      storage_type,
      file_size_bytes,
      media_type,
      ingest_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const result = stmt.run(
    userId,
    imageHash,
    now,
    thumbnailStorageKey || null,
    storageType || null,
    fileSizeBytes || null,
    normalizedType,
  );

  if (result.changes > 0) {
    const media = db.prepare("SELECT id FROM media WHERE user_id = ? AND file_hash = ? LIMIT 1").get(userId, imageHash);
    if (media?.id) {
      db.prepare(
        "INSERT OR IGNORE INTO media_analysis (media_id, analysis_status, analysis_version) VALUES (?, 'pending', '1.0')",
      ).run(media.id);
      rebuildMediaSearchDoc(media.id);
    }
  }

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
function selectImagesByYear({ pageNo, pageSize, albumId, userId, clusterId = null }) {
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
        i.storage_type, 
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
        storage_type, 
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
function selectImagesByMonth({ pageNo, pageSize, albumId, userId, clusterId = null }) {
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
        i.storage_type, 
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
        storage_type, 
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
function selectImagesByDate({ pageNo, pageSize, albumId, userId }) {
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
      storage_type, 
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
function getImagesByBlurry({ userId, pageNo, pageSize }) {
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
      storage_type,
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
  const now = Date.now();
  const placeholders = idsSet.length > 0 ? idsSet.map(() => "?").join(", ") : "NULL";

  const upsertBlurry =
    idsSet.length > 0
      ? db.prepare(`
        INSERT INTO media_analysis (media_id, analysis_status, analysis_version, is_blurry, updated_at)
        SELECT id, 'pending', '1.0', 1, ?
        FROM media
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
        ON CONFLICT(media_id) DO UPDATE SET
          is_blurry = 1,
          updated_at = excluded.updated_at
      `)
      : null;

  const clearBlurry = db.prepare(`
    UPDATE media_analysis
    SET is_blurry = 0, updated_at = ?
    WHERE media_id IN (
      SELECT id FROM media
      WHERE user_id = ? AND deleted_at IS NULL
      ${idsSet.length > 0 ? `AND id NOT IN (${placeholders})` : ""}
    )
  `);

  if (upsertBlurry) upsertBlurry.run(now, userId, ...idsSet);
  if (idsSet.length > 0) {
    clearBlurry.run(now, userId, ...idsSet);
  } else {
    clearBlurry.run(now, userId);
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
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY month_key 
          ORDER BY 
            -- 🥰 封面选择策略：综合考虑表情和清晰度
            -- 注意：expression_tags/face_count/person_count为NULL时表示未分析
            -- SQLite中NULL与任何值比较都返回NULL，在CASE WHEN中被视为FALSE
            -- 因此未分析的图片会自动落入最低优先级（兜底策略）
            CASE 
              -- 🏆 第一优先级：开心且清晰（综合最优，有人脸）
              WHEN expression_tags LIKE 'happy%' 
                   AND primary_expression_confidence > 0.7 
                   AND primary_face_quality > 0.7 
                   AND face_count > 0 
                   THEN 1
              -- 😊 第二优先级：主要是开心（有人脸即可）
              WHEN expression_tags LIKE 'happy%' 
                   AND primary_expression_confidence > 0.7 
                   AND face_count > 0 
                   THEN 2
              -- 📸 第三优先级：清晰度高（有人脸，不限表情）
              WHEN primary_face_quality > 0.8 
                   AND face_count > 0 
                   THEN 3
              -- 👤 第四优先级：有人脸的图片（不限表情和质量）
              WHEN face_count > 0 THEN 4
              -- 🚶 第五优先级：有人物但无人脸（背影、远景）
              WHEN person_count > 0 THEN 5
              -- ⏰ 第六优先级：其他所有图片（包括未分析的图片，兜底策略）
              ELSE 6
            END,
            -- 🔢 同优先级内的精细排序：
            COALESCE(primary_expression_confidence, 0) DESC,  -- 表情置信度高的优先
            COALESCE(primary_face_quality, 0) DESC,           -- 人脸质量好的优先
            COALESCE(face_count, 0) DESC,                     -- 人脸数量多的优先（更热闹）
            COALESCE(person_count, 0) DESC,                   -- 人物数量多的优先
            COALESCE(captured_at, 0) DESC,             -- 时间最新的优先
            id DESC                                          -- ID最大的优先（保证排序稳定）
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
        id,
        storage_type
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
      latest.storage_type,
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
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY year_key 
          ORDER BY 
            -- 🥰 封面选择策略：综合考虑表情和清晰度
            -- 注意：AI字段为NULL时表示未分析，会自动落入最低优先级
            CASE 
              -- 🏆 第一优先级：开心且清晰（综合最优，有人脸）
              WHEN expression_tags LIKE 'happy%' 
                   AND primary_expression_confidence > 0.7 
                   AND primary_face_quality > 0.7 
                   AND face_count > 0 
                   THEN 1
              -- 😊 第二优先级：主要是开心（有人脸即可）
              WHEN expression_tags LIKE 'happy%' 
                   AND primary_expression_confidence > 0.7 
                   AND face_count > 0 
                   THEN 2
              -- 📸 第三优先级：清晰度高（有人脸，不限表情）
              WHEN primary_face_quality > 0.8 
                   AND face_count > 0 
                   THEN 3
              -- 👤 第四优先级：有人脸的图片（不限表情和质量）
              WHEN face_count > 0 THEN 4
              -- 🚶 第五优先级：有人物但无人脸（背影、远景）
              WHEN person_count > 0 THEN 5
              -- ⏰ 第六优先级：其他所有图片（包括未分析的图片，兜底策略）
              ELSE 6
            END,
            COALESCE(primary_expression_confidence, 0) DESC,
            COALESCE(primary_face_quality, 0) DESC,
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
        id,
        storage_type
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
      latest.storage_type,
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

// 获取「未知时间」相册（year_key='unknown' 的单个分组）
function selectUnknownGroup({ userId }) {
  const dataQuery = db.prepare(`
    WITH ranked AS (
      SELECT 
        year_key,
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(captured_at, 0) DESC, id DESC
        ) AS rn
      FROM media
      WHERE user_id = ? AND deleted_at IS NULL AND year_key = 'unknown'
        AND (COALESCE(media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    cover AS (
      SELECT year_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked WHERE rn = 1
    ),
    cnt AS (
      SELECT COUNT(*) AS imageCount FROM media
      WHERE user_id = ? AND deleted_at IS NULL AND year_key = 'unknown'
    )
    SELECT
      'unknown' AS album_id,
      cover.thumbnail_storage_key AS latestImagekey,
      cover.captured_at,
      cover.storage_type,
      cnt.imageCount
    FROM cover CROSS JOIN cnt;
  `);
  const countQuery = db.prepare(`
    SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS groupCount
    FROM media
    WHERE user_id = ? AND deleted_at IS NULL AND year_key = 'unknown';
  `);
  try {
    const data = dataQuery.all(userId, userId);
    const { groupCount: total } = countQuery.get(userId);
    if (!data || data.length === 0) {
      return { data: [], total: 0 };
    }
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
        i.thumbnail_storage_key,
        i.captured_at,
        i.id,
        i.storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY i.year_key 
          ORDER BY 
            CASE 
              WHEN i.expression_tags LIKE 'happy%' 
                   AND i.primary_expression_confidence > 0.7 
                   AND i.primary_face_quality > 0.7 
                   AND i.face_count > 0 
                   THEN 1
              WHEN i.expression_tags LIKE 'happy%' 
                   AND i.primary_expression_confidence > 0.7 
                   AND i.face_count > 0 
                   THEN 2
              WHEN i.primary_face_quality > 0.8 
                   AND i.face_count > 0 
                   THEN 3
              WHEN i.face_count > 0 THEN 4
              WHEN i.person_count > 0 THEN 5
              ELSE 6
            END,
            COALESCE(i.primary_expression_confidence, 0) DESC,
            COALESCE(i.primary_face_quality, 0) DESC,
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
        id,
        storage_type
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
      latest.storage_type,
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
        i.thumbnail_storage_key,
        i.captured_at,
        i.id,
        i.storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY i.month_key 
          ORDER BY 
            CASE 
              WHEN i.expression_tags LIKE 'happy%' 
                   AND i.primary_expression_confidence > 0.7 
                   AND i.primary_face_quality > 0.7 
                   AND i.face_count > 0 
                   THEN 1
              WHEN i.expression_tags LIKE 'happy%' 
                   AND i.primary_expression_confidence > 0.7 
                   AND i.face_count > 0 
                   THEN 2
              WHEN i.primary_face_quality > 0.8 
                   AND i.face_count > 0 
                   THEN 3
              WHEN i.face_count > 0 THEN 4
              WHEN i.person_count > 0 THEN 5
              ELSE 6
            END,
            COALESCE(i.primary_expression_confidence, 0) DESC,
            COALESCE(i.primary_face_quality, 0) DESC,
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
        id,
        storage_type
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
      latest.storage_type,
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
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY date_key 
          ORDER BY 
            -- 🥰 封面选择策略：综合考虑表情和清晰度
            -- 注意：AI字段为NULL时表示未分析，会自动落入最低优先级
            CASE 
              -- 🏆 第一优先级：开心且清晰（综合最优，有人脸）
              WHEN expression_tags LIKE 'happy%' 
                   AND primary_expression_confidence > 0.7 
                   AND primary_face_quality > 0.7 
                   AND face_count > 0 
                   THEN 1
              -- 😊 第二优先级：主要是开心（有人脸即可）
              WHEN expression_tags LIKE 'happy%' 
                   AND primary_expression_confidence > 0.7 
                   AND face_count > 0 
                   THEN 2
              -- 📸 第三优先级：清晰度高（有人脸，不限表情）
              WHEN primary_face_quality > 0.8 
                   AND face_count > 0 
                   THEN 3
              -- 👤 第四优先级：有人脸的图片（不限表情和质量）
              WHEN face_count > 0 THEN 4
              -- 🚶 第五优先级：有人物但无人脸（背影、远景）
              WHEN person_count > 0 THEN 5
              -- ⏰ 第六优先级：其他所有图片（包括未分析的图片，兜底策略）
              ELSE 6
            END,
            COALESCE(primary_expression_confidence, 0) DESC,
            COALESCE(primary_face_quality, 0) DESC,
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
        id,
        storage_type
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

// 分页获取用户按地点（city）分组的数据
// 使用 COALESCE(NULLIF(TRIM(city), ''), 'unknown') 统一处理 NULL/空/unknown
function selectGroupsByCity({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  const dataQuery = db.prepare(`
    WITH city_normalized AS (
      SELECT 
        id,
        COALESCE(NULLIF(TRIM(city), ''), 'unknown') AS city_key,
        thumbnail_storage_key,
        captured_at,
        storage_type
      FROM media
      WHERE user_id = ? AND deleted_at IS NULL
        AND (COALESCE(media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    ranked_images AS (
      SELECT 
        city_key,
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY city_key 
          ORDER BY captured_at DESC, id DESC
        ) AS rn
      FROM city_normalized
    ),
    latest AS (
      SELECT city_key, thumbnail_storage_key, captured_at, id, storage_type
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
      latest.storage_type,
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
    SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(city), ''), 'unknown')) AS groupCount
    FROM media
    WHERE user_id = ? AND deleted_at IS NULL;
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
// albumId: 城市名称或 'unknown'
function selectImagesByCity({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const isUnknown = albumId === "unknown";

  const baseSelect = `
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
      storage_type, 
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
    WHERE user_id = ? AND deleted_at IS NULL
  `;
  const cityCondition = isUnknown ? " AND (city IS NULL OR TRIM(COALESCE(city, '')) = '' OR city = 'unknown')" : " AND city = ?";
  const orderLimit = " ORDER BY COALESCE(captured_at, 0) DESC, id DESC LIMIT ? OFFSET ?";

  const dataQuery = db.prepare(baseSelect + cityCondition + orderLimit);
  const countQuery = db.prepare("SELECT COUNT(*) AS total FROM media WHERE user_id = ? AND deleted_at IS NULL" + cityCondition);

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
function updateImageMetadata({
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
  mime,
  durationSec,
  videoCodec,
  mediaType,
}) {
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
      media_type = COALESCE(?, media_type),
      ingest_status = 'ready'
    WHERE user_id = ? AND file_hash = ? RETURNING id
  `;

  const stmt = db.prepare(sql);
  const result = stmt.get(
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
    mime,
    durationSec,
    videoCodec,
    mediaType,
    userId,
    imageHash,
  );

  return {
    affectedRows: result ? 1 : 0,
    imageId: result?.id || null,
  };
}

// 检查文件是否已存在（用于预检）
function checkFileExists({ imageHash, userId }) {
  const stmt = db.prepare(`
    SELECT id
    FROM media
    WHERE file_hash = ? AND user_id = ?
    LIMIT 1
  `);
  return stmt.get(imageHash, userId);
}

/**
 * 更新图片的搜索相关字段
 */
/**
 * 📝 更新图片搜索元数据到images表
 *
 * 功能说明:
 * • 存储人脸识别分析结果的汇总信息
 * • 支持增量更新：null值不更新，保持原有值
 *
 * @function updateImageSearchMetadata
 * @param {Object} params - 更新参数对象
 * @param {number} params.imageId - 图片ID（必须）
 * @param {string} [params.altText] - AI图片描述（待启用）
 * @param {string} [params.ocrText] - OCR识别的文字内容
 * @param {string} [params.keywords] - 关键词（待启用）
 * @param {string} [params.sceneTags] - 场景标签（待启用）
 * @param {string} [params.objectTags] - 物体标签（待启用）
 * @param {number} [params.faceCount] - 人脸数量
 * @param {number} [params.personCount] - 人物总数（包括背面、远景）【2025-10-27 新增】
 * @param {string} [params.expressionTags] - 表情标签（逗号分隔）如："happy,neutral"
 * @param {string} [params.ageTags] - 年龄段标签（逗号分隔）如："20-29,0-2"
 * @param {string} [params.genderTags] - 性别标签（逗号分隔）如："female,male"
 * @param {number} [params.primaryExpressionConfidence] - 主要人物表情置信度 (0-1)
 * @param {number} [params.primaryFaceQuality] - 主要人脸质量 (0-1)
 * @param {string} [params.analysisVersion='1.0'] - 分析版本号，默认'1.0'
 *
 * @returns {Object} 返回对象 { affectedRows: 更新的行数 }
 *
 * 💡 使用场景:
 * • 人脸识别完成后，存储汇总信息
 * • 支持按标签快速筛选照片
 * • 支持按质量排序照片
 *
 * ⚠️ 注意事项:
 * • 传入null不会更新该字段（使用COALESCE保护）
 * • 传入undefined会被转为null
 * • analysisVersion默认为'1.0'，可传入其他版本如'2.0'
 */
function updateImageSearchMetadata({
  imageId,
  altText,
  ocrText,
  keywords,
  sceneTags,
  objectTags,
  faceCount,
  personCount,
  expressionTags,
  ageTags,
  genderTags,
  primaryExpressionConfidence,
  primaryFaceQuality,
  analysisVersion = "1.0",
}) {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO media_analysis (media_id, analysis_status, analysis_version)
      VALUES (?, 'pending', ?)
    `).run(imageId, analysisVersion);

    const analysisUpdate = db.prepare(`
      UPDATE media_analysis
      SET
        face_count = COALESCE(?, face_count),
        person_count = COALESCE(?, person_count),
        primary_face_quality = COALESCE(?, primary_face_quality),
        primary_expression = COALESCE(?, primary_expression),
        primary_expression_confidence = COALESCE(?, primary_expression_confidence),
        scene_primary = COALESCE(?, scene_primary),
        has_caption = CASE WHEN ? IS NOT NULL THEN 1 ELSE has_caption END,
        has_ocr = CASE WHEN ? IS NOT NULL THEN 1 ELSE has_ocr END,
        analysis_version = COALESCE(?, analysis_version),
        analysis_status = 'done',
        analyzed_at = ?
      WHERE media_id = ?
    `);
    const result = analysisUpdate.run(
      faceCount,
      personCount,
      primaryFaceQuality,
      pickPrimaryTag(expressionTags),
      primaryExpressionConfidence,
      pickPrimaryTag(sceneTags),
      altText,
      ocrText,
      analysisVersion,
      Date.now(),
      imageId,
    );

    if (altText || keywords) {
      db.prepare("DELETE FROM media_captions WHERE media_id = ? AND source_type = 'image'").run(imageId);
      db.prepare(`
        INSERT INTO media_captions (
          media_id, source_type, source_ref_id, language, caption, keywords_json, analysis_version, created_at
        ) VALUES (?, 'image', NULL, 'auto', ?, ?, ?, ?)
      `).run(imageId, altText || null, toJsonArrayString(keywords), analysisVersion, Date.now());
    }

    if (ocrText) {
      db.prepare("DELETE FROM media_text_blocks WHERE media_id = ? AND source_type = 'ocr'").run(imageId);
      db.prepare(`
        INSERT INTO media_text_blocks (media_id, source_type, text, analysis_version, created_at)
        VALUES (?, 'ocr', ?, ?, ?)
      `).run(imageId, ocrText, analysisVersion, Date.now());
    }

    if (objectTags) {
      db.prepare("DELETE FROM media_objects WHERE media_id = ? AND source_type = 'image'").run(imageId);
      const insertObject = db.prepare(`
        INSERT INTO media_objects (
          media_id, source_type, source_ref_id, label, confidence, bbox, analysis_version, created_at
        ) VALUES (?, 'image', NULL, ?, NULL, NULL, ?, ?)
      `);
      for (const label of parseCommaTags(objectTags)) {
        insertObject.run(imageId, label, analysisVersion, Date.now());
      }
    }

    rebuildMediaSearchDoc(imageId);
    return { affectedRows: result.changes };
  });

  return tx();
}

// 异步更新图片位置信息
function updateLocationInfo(imageId, { gpsLocation, country, city }) {
  const sql = `
    UPDATE media SET
      gps_location = COALESCE(?, gps_location),
      country = COALESCE(?, country),
      city = COALESCE(?, city)
    WHERE id = ?
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(gpsLocation, country, city, imageId);

  rebuildMediaSearchDoc(imageId);
  return { affectedRows: result.changes };
}

function updateIngestStatusByHash({ userId, imageHash, ingestStatus }) {
  const allowed = new Set(["pending", "processing", "ready", "failed"]);
  const status = allowed.has(ingestStatus) ? ingestStatus : "pending";
  const result = db
    .prepare(
      `
      UPDATE media
      SET ingest_status = ?
      WHERE user_id = ? AND file_hash = ?
    `,
    )
    .run(status, userId, imageHash);
  return { affectedRows: result.changes };
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
 * @param {string} [analysisVersion] - 分析版本，写入 media_face_embeddings.analysis_version；不传时默认 '1.0'
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
async function insertFaceEmbeddings(imageId, faceData, analysisVersion) {
  const version = analysisVersion != null && analysisVersion !== "" ? String(analysisVersion) : "1.0";
  try {
    const deleteSql = `DELETE FROM media_face_embeddings WHERE media_id = ? AND source_type = 'image'`;
    const deleteStmt = db.prepare(deleteSql);
    deleteStmt.run(imageId);

    if (!faceData || faceData.length === 0) {
      return { affectedRows: 0 };
    }

    // 批量插入新的人脸数据
    // 优化（2025-12-XX）：添加quality_score、bbox、pose字段，移除face_thumbnail_storage_key处理
    // 缩略图将在聚类后，只为最佳人脸生成
    const insertSql = `
      INSERT INTO media_face_embeddings (
        media_id, source_type, source_ref_id, face_index, embedding, age, gender, expression, confidence, quality_score, bbox, pose, analysis_version
      ) VALUES (?, 'image', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const insertStmt = db.prepare(insertSql);

    let totalAffected = 0;
    for (const face of faceData) {
      // 将embedding数组转换为Buffer存储
      const embeddingBuffer = Buffer.from(JSON.stringify(face.embedding));

      // 优化（2025-12-XX）：不再处理 face_thumbnail_base64
      // 缩略图将在聚类后，只为最佳人脸生成

      const result = insertStmt.run(
        imageId,
        face.face_index,
        embeddingBuffer,
        face.age || null,
        face.gender || null,
        face.expression || null,
        face.confidence || null,
        face.quality_score || null,
        JSON.stringify(face.bbox || []), // bbox存储为JSON字符串
        JSON.stringify(face.pose || {}), // pose存储为JSON字符串
        version,
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
function getImageStorageInfo(imageId) {
  const sql = `
    SELECT 
      id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key,
      storage_type,
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
    storageType: image.storage_type,
    mediaType: image.media_type || "image",
  };
}

/**
 * 根据ID获取图片下载信息（包含 original_storage_key，用于下载）
 */
function getImageDownloadInfo({ userId, imageId }) {
  const sql = `
    SELECT 
      id,
      media_type,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key,
      storage_type
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
    storageType: image.storage_type,
  };
}

/**
 * 批量根据 imageIds 获取图片下载信息（用于批量下载）
 */
function getImagesDownloadInfo({ userId, imageIds }) {
  if (!imageIds || imageIds.length === 0) {
    return [];
  }

  const placeholders = imageIds.map(() => "?").join(",");
  const sql = `
    SELECT 
      id,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key,
      storage_type
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
    storageType: image.storage_type,
  }));
}

// ==================== media 重构后的查询实现（覆盖旧 images 查询） ====================
function _mediaSelectColumns(alias = "m") {
  return `
    ${alias}.id,
    ${alias}.high_res_storage_key,
    ${alias}.thumbnail_storage_key,
    ${alias}.original_storage_key,
    ${alias}.media_type,
    ${alias}.duration_sec,
    ${alias}.captured_at AS captured_at,
    ${alias}.date_key,
    ${alias}.day_key,
    ${alias}.month_key,
    ${alias}.year_key,
    ${alias}.storage_type,
    ${alias}.gps_location,
    ${alias}.width_px,
    ${alias}.height_px,
    ${alias}.aspect_ratio,
    ${alias}.layout_type,
    ${alias}.file_size_bytes,
    COALESCE(ma.face_count, 0) AS face_count,
    COALESCE(ma.person_count, 0) AS person_count,
    NULL AS age_tags,
    ma.primary_expression AS expression_tags,
    ${alias}.is_favorite
  `;
}

function getImagesByBlurry({ userId, pageNo, pageSize }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    SELECT
      m.id,
      m.high_res_storage_key,
      m.thumbnail_storage_key,
      m.captured_at,
      m.created_at,
      m.date_key,
      m.day_key,
      m.month_key,
      m.year_key,
      m.storage_type,
      m.gps_location,
      m.width_px,
      m.height_px,
      m.aspect_ratio,
      m.layout_type,
      m.file_size_bytes,
      COALESCE(ma.face_count, 0) AS face_count,
      COALESCE(ma.person_count, 0) AS person_count,
      NULL AS age_tags,
      ma.primary_expression AS expression_tags,
      m.is_favorite
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.user_id = ?
      AND COALESCE(ma.is_blurry, 0) = 1
      AND m.deleted_at IS NULL
    ORDER BY COALESCE(ma.sharpness_score, 0) ASC, m.id ASC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.user_id = ?
      AND COALESCE(ma.is_blurry, 0) = 1
      AND m.deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, pageSize, offset);
  const { total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

function selectImagesByYear({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  const offset = (pageNo - 1) * pageSize;
  if (clusterId !== null && clusterId !== undefined) {
    const dataQuery = db.prepare(`
      SELECT
        ${_mediaSelectColumns("m")},
        MIN(mfe.id) AS face_embedding_id
      FROM media m
      LEFT JOIN media_analysis ma ON ma.media_id = m.id
      INNER JOIN media_face_embeddings mfe ON m.id = mfe.media_id
      INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id
      WHERE m.user_id = ?
        AND m.year_key = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
      GROUP BY m.id
      ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC
      LIMIT ? OFFSET ?
    `);
    const countQuery = db.prepare(`
      SELECT COUNT(DISTINCT m.id) AS total
      FROM media m
      INNER JOIN media_face_embeddings mfe ON m.id = mfe.media_id
      INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id
      WHERE m.user_id = ?
        AND m.year_key = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
    `);
    const data = dataQuery.all(userId, albumId, clusterId, pageSize, offset);
    const { total } = countQuery.get(userId, albumId, clusterId);
    return { data: mapFields("media", data), total };
  }
  const dataQuery = db.prepare(`
    SELECT ${_mediaSelectColumns("m")}
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.user_id = ?
      AND m.year_key = ?
      AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media m
    WHERE m.user_id = ?
      AND m.year_key = ?
      AND m.deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, albumId, pageSize, offset);
  const { total } = countQuery.get(userId, albumId);
  return { data: mapFields("media", data), total };
}

function selectImagesByMonth({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  const offset = (pageNo - 1) * pageSize;
  if (clusterId !== null && clusterId !== undefined) {
    const dataQuery = db.prepare(`
      SELECT
        ${_mediaSelectColumns("m")},
        MIN(mfe.id) AS face_embedding_id
      FROM media m
      LEFT JOIN media_analysis ma ON ma.media_id = m.id
      INNER JOIN media_face_embeddings mfe ON m.id = mfe.media_id
      INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id
      WHERE m.user_id = ?
        AND m.month_key = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
      GROUP BY m.id
      ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC
      LIMIT ? OFFSET ?
    `);
    const countQuery = db.prepare(`
      SELECT COUNT(DISTINCT m.id) AS total
      FROM media m
      INNER JOIN media_face_embeddings mfe ON m.id = mfe.media_id
      INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id
      WHERE m.user_id = ?
        AND m.month_key = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
    `);
    const data = dataQuery.all(userId, albumId, clusterId, pageSize, offset);
    const { total } = countQuery.get(userId, albumId, clusterId);
    return { data: mapFields("media", data), total };
  }
  const dataQuery = db.prepare(`
    SELECT ${_mediaSelectColumns("m")}
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.user_id = ?
      AND m.month_key = ?
      AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media m
    WHERE m.user_id = ?
      AND m.month_key = ?
      AND m.deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, albumId, pageSize, offset);
  const { total } = countQuery.get(userId, albumId);
  return { data: mapFields("media", data), total };
}

function selectImagesByDate({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    SELECT ${_mediaSelectColumns("m")}
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.user_id = ?
      AND m.date_key = ?
      AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media m
    WHERE m.user_id = ?
      AND m.date_key = ?
      AND m.deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, albumId, pageSize, offset);
  const { total } = countQuery.get(userId, albumId);
  return { data: mapFields("media", data), total };
}

function selectImagesByCity({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const isUnknown = albumId === "unknown";
  const cityCondition = isUnknown ? "AND (m.city IS NULL OR TRIM(COALESCE(m.city, '')) = '' OR m.city = 'unknown')" : "AND m.city = ?";

  const dataQuery = db.prepare(`
    SELECT ${_mediaSelectColumns("m")}
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.user_id = ?
      AND m.deleted_at IS NULL
      ${cityCondition}
    ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media m
    WHERE m.user_id = ?
      AND m.deleted_at IS NULL
      ${cityCondition}
  `);

  const params = isUnknown ? [userId, pageSize, offset] : [userId, albumId, pageSize, offset];
  const countParams = isUnknown ? [userId] : [userId, albumId];
  const data = dataQuery.all(...params);
  const { total } = countQuery.get(...countParams);
  return { data: mapFields("media", data), total };
}

function selectGroupsByMonth({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    WITH ranked_media AS (
      SELECT
        m.month_key,
        m.thumbnail_storage_key,
        m.captured_at,
        m.id,
        m.storage_type,
        ROW_NUMBER() OVER (PARTITION BY m.month_key ORDER BY COALESCE(m.captured_at,0) DESC, m.id DESC) AS rn
      FROM media m
      WHERE m.user_id = ?
        AND m.deleted_at IS NULL
        AND m.month_key != 'unknown'
    ),
    latest AS (
      SELECT month_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked_media
      WHERE rn = 1
    ),
    counts AS (
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
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.month_key = latest.month_key
    ORDER BY latest.month_key DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT month_key) AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND month_key != 'unknown'
  `);
  const data = dataQuery.all(userId, userId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

function selectGroupsByYearForCluster({ pageNo, pageSize, userId, clusterId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    WITH ranked_media AS (
      SELECT
        m.year_key,
        m.thumbnail_storage_key,
        m.captured_at,
        m.id,
        m.storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY m.year_key
          ORDER BY COALESCE(m.captured_at,0) DESC, m.id DESC
        ) AS rn
      FROM face_clusters fc
      INNER JOIN media_face_embeddings mfe ON fc.face_embedding_id = mfe.id
      INNER JOIN media m ON mfe.media_id = m.id
      WHERE fc.user_id = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
    ),
    latest AS (
      SELECT year_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked_media
      WHERE rn = 1
    ),
    counts AS (
      SELECT m.year_key, COUNT(DISTINCT m.id) AS imageCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings mfe ON fc.face_embedding_id = mfe.id
      INNER JOIN media m ON mfe.media_id = m.id
      WHERE fc.user_id = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
      GROUP BY m.year_key
    )
    SELECT
      latest.year_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.year_key = latest.year_key
    ORDER BY
      CASE WHEN latest.year_key = 'unknown' THEN 1 ELSE 0 END,
      latest.year_key DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT m.year_key) AS groupCount
    FROM face_clusters fc
    INNER JOIN media_face_embeddings mfe ON fc.face_embedding_id = mfe.id
    INNER JOIN media m ON mfe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, clusterId, userId, clusterId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId, clusterId);
  return { data: mapFields("media", data), total };
}

function selectGroupsByMonthForCluster({ pageNo, pageSize, userId, clusterId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    WITH ranked_media AS (
      SELECT
        m.month_key,
        m.thumbnail_storage_key,
        m.captured_at,
        m.id,
        m.storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY m.month_key
          ORDER BY COALESCE(m.captured_at,0) DESC, m.id DESC
        ) AS rn
      FROM face_clusters fc
      INNER JOIN media_face_embeddings mfe ON fc.face_embedding_id = mfe.id
      INNER JOIN media m ON mfe.media_id = m.id
      WHERE fc.user_id = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
    ),
    latest AS (
      SELECT month_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked_media
      WHERE rn = 1
    ),
    counts AS (
      SELECT m.month_key, COUNT(DISTINCT m.id) AS imageCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings mfe ON fc.face_embedding_id = mfe.id
      INNER JOIN media m ON mfe.media_id = m.id
      WHERE fc.user_id = ?
        AND fc.cluster_id = ?
        AND m.deleted_at IS NULL
      GROUP BY m.month_key
    )
    SELECT
      latest.month_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.month_key = latest.month_key
    ORDER BY
      CASE WHEN latest.month_key = 'unknown' THEN 1 ELSE 0 END,
      latest.month_key DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT m.month_key) AS groupCount
    FROM face_clusters fc
    INNER JOIN media_face_embeddings mfe ON fc.face_embedding_id = mfe.id
    INNER JOIN media m ON mfe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, clusterId, userId, clusterId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId, clusterId);
  return { data: mapFields("media", data), total };
}

function selectGroupsByYear({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    WITH ranked_media AS (
      SELECT
        m.year_key,
        m.thumbnail_storage_key,
        m.captured_at,
        m.id,
        m.storage_type,
        ROW_NUMBER() OVER (PARTITION BY m.year_key ORDER BY COALESCE(m.captured_at,0) DESC, m.id DESC) AS rn
      FROM media m
      WHERE m.user_id = ?
        AND m.deleted_at IS NULL
        AND m.year_key != 'unknown'
    ),
    latest AS (
      SELECT year_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked_media
      WHERE rn = 1
    ),
    counts AS (
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
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.year_key = latest.year_key
    ORDER BY latest.year_key DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT year_key) AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND year_key != 'unknown'
  `);
  const data = dataQuery.all(userId, userId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

function selectUnknownGroup({ userId }) {
  const dataQuery = db.prepare(`
    WITH ranked AS (
      SELECT
        year_key,
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (ORDER BY COALESCE(captured_at,0) DESC, id DESC) AS rn
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND year_key = 'unknown'
    ),
    cover AS (
      SELECT year_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked WHERE rn = 1
    ),
    cnt AS (
      SELECT COUNT(*) AS imageCount
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND year_key = 'unknown'
    )
    SELECT
      'unknown' AS album_id,
      cover.thumbnail_storage_key AS latestImagekey,
      cover.captured_at,
      cover.storage_type,
      cnt.imageCount
    FROM cover CROSS JOIN cnt
  `);
  const countQuery = db.prepare(`
    SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND year_key = 'unknown'
  `);
  const data = dataQuery.all(userId, userId);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

function selectGroupsByDate({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    WITH ranked_media AS (
      SELECT
        m.date_key,
        m.thumbnail_storage_key,
        m.captured_at,
        m.id,
        m.storage_type,
        ROW_NUMBER() OVER (PARTITION BY m.date_key ORDER BY COALESCE(m.captured_at,0) DESC, m.id DESC) AS rn
      FROM media m
      WHERE m.user_id = ?
        AND m.deleted_at IS NULL
    ),
    latest AS (
      SELECT date_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked_media
      WHERE rn = 1
    ),
    counts AS (
      SELECT date_key, COUNT(*) AS imageCount
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
      GROUP BY date_key
    )
    SELECT
      latest.date_key AS album_id,
      latest.thumbnail_storage_key AS latestImagekey,
      latest.captured_at,
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.date_key = latest.date_key
    ORDER BY
      CASE WHEN latest.date_key = 'unknown' THEN 1 ELSE 0 END,
      latest.date_key DESC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT date_key) AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, userId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

function selectGroupsByCity({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    WITH city_normalized AS (
      SELECT
        id,
        COALESCE(NULLIF(TRIM(city), ''), 'unknown') AS city_key,
        thumbnail_storage_key,
        captured_at,
        storage_type
      FROM media
      WHERE user_id = ?
        AND deleted_at IS NULL
    ),
    ranked_media AS (
      SELECT
        city_key,
        thumbnail_storage_key,
        captured_at,
        id,
        storage_type,
        ROW_NUMBER() OVER (
          PARTITION BY city_key
          ORDER BY COALESCE(captured_at,0) DESC, id DESC
        ) AS rn
      FROM city_normalized
    ),
    latest AS (
      SELECT city_key, thumbnail_storage_key, captured_at, storage_type
      FROM ranked_media
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
      latest.storage_type,
      counts.imageCount
    FROM latest
    JOIN counts ON counts.city_key = latest.city_key
    ORDER BY
      CASE WHEN latest.city_key = 'unknown' THEN 1 ELSE 0 END,
      counts.imageCount DESC,
      latest.city_key ASC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(city), ''), 'unknown')) AS groupCount
    FROM media
    WHERE user_id = ?
      AND deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

module.exports = {
  checkFileExists,
  insertImage,
  updateImageMetadata,
  updateImageSearchMetadata,
  updateLocationInfo,
  insertFaceEmbeddings,
  selectImagesByYear,
  selectImagesByMonth,
  selectImagesByDate,
  getImagesByBlurry,
  updateBlurryForUser,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectGroupsByDate,
  selectUnknownGroup,
  selectGroupsByCity,
  selectImagesByCity,
  selectGroupsByYearForCluster,
  selectGroupsByMonthForCluster,
  selectHashesByUserId,
  getImageStorageInfo,
  getImageDownloadInfo,
  getImagesDownloadInfo,
  rebuildMediaSearchDoc,
  updateIngestStatusByHash,
};
