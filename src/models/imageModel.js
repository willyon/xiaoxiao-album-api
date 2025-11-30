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
  // 使用固定 SQL，NULL 值会自动使用数据库 DEFAULT 值
  const sql = `
    INSERT OR IGNORE INTO images (
      user_id, 
      image_hash, 
      created_at,
      thumbnail_storage_key,
      storage_type,
      file_size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?)
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(userId, imageHash, Date.now(), thumbnailStorageKey || null, storageType || null, fileSizeBytes || null);

  return { affectedRows: result.changes };
}

// 获取用户所有图片hash
function selectHashesByUserId(userId) {
  // pluck() 会让返回值从对象([{hash:'123'}, {hash:'2323'}])变为单列值(取结果的第一列也就是这里的{hash:'123'})['123', '2323']，
  const stmt = db.prepare(`SELECT image_hash FROM images WHERE user_id = ? AND deleted_at IS NULL`).pluck();
  return stmt.all(userId);
}

//分页获取用户全部图片数据
function selectImagesByPage({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询
  const dataQuery = db.prepare(`
    SELECT 
      id,
      high_res_storage_key, 
      thumbnail_storage_key, 
      image_created_at, 
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
      color_theme,
      file_size_bytes,
      face_count,
      person_count,
      age_tags,
      gender_tags,
      expression_tags,
      has_young,
      has_adult,
      is_favorite
    FROM images
    WHERE user_id = ?
      AND deleted_at IS NULL
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  // 总数统计（与分页查询保持相同过滤条件）
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND deleted_at IS NULL
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
// albumId: 对于时间相册，实际上是 year_key (如 "2024")
function selectImagesByYear({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT 
      id,
      high_res_storage_key, 
      thumbnail_storage_key, 
      image_created_at, 
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
      color_theme,
      file_size_bytes,
      face_count,
      person_count,
      age_tags,
      gender_tags,
      expression_tags,
      has_young,
      has_adult,
      is_favorite
    FROM images
    WHERE user_id = ?
      AND year_key = ?
      AND deleted_at IS NULL
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND year_key = ?
      AND deleted_at IS NULL
  `);

  try {
    const data = dataQuery.all(userId, albumId, pageSize, offset);
    const { total } = countQuery.get(userId, albumId);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
  }
}

// 分页获取用户具体某月份的图片数据 —— 基于物化的 monthKey
// albumId: 对于时间相册，实际上是 month_key (如 "2024-01")
function selectImagesByMonth({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;

  // 分页数据查询（与总数统计保持相同过滤条件）
  const dataQuery = db.prepare(`
    SELECT 
      id,
      high_res_storage_key, 
      thumbnail_storage_key, 
      image_created_at, 
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
      color_theme,
      file_size_bytes,
      face_count,
      person_count,
      age_tags,
      gender_tags,
      expression_tags,
      has_young,
      has_adult,
      is_favorite
    FROM images
    WHERE user_id = ?
      AND month_key = ?
      AND deleted_at IS NULL
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND month_key = ?
      AND deleted_at IS NULL
  `);

  try {
    const data = dataQuery.all(userId, albumId, pageSize, offset);
    const { total } = countQuery.get(userId, albumId);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
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
      image_created_at, 
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
      color_theme,
      file_size_bytes,
      face_count,
      person_count,
      age_tags,
      gender_tags,
      expression_tags,
      has_young,
      has_adult,
      is_favorite
    FROM images
    WHERE user_id = ?
      AND date_key = ?
      AND deleted_at IS NULL
    ORDER BY COALESCE(image_created_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM images
    WHERE user_id = ?
      AND date_key = ?
      AND deleted_at IS NULL
  `);

  try {
    const data = dataQuery.all(userId, albumId, pageSize, offset);
    const { total } = countQuery.get(userId, albumId);
    return { data: mapFields("images", data), total };
  } catch (error) {
    throw error;
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
        image_created_at,
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
            COALESCE(image_created_at, 0) DESC,             -- 时间最新的优先
            id DESC                                          -- ID最大的优先（保证排序稳定）
        ) AS rn
      FROM images
      WHERE user_id = ?
        AND deleted_at IS NULL
    ),
    latest AS (
      -- 选择每个月份的第一张图片作为封面
      SELECT 
        month_key,
        thumbnail_storage_key,
        image_created_at,
        id,
        storage_type
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      -- 📊 统计每个月份的照片数量
      SELECT month_key, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
        AND deleted_at IS NULL
      GROUP BY month_key
    )
    SELECT
      latest.month_key AS album_id,  -- 相册ID（统一使用 album_id，mapper 会映射为 albumId）
      latest.thumbnail_storage_key AS latestImagekey,  -- 封面图片的缩略图存储键
      latest.image_created_at,  -- 封面图片的拍摄时间
      latest.storage_type,      -- 封面图片的存储类型
      counts.imageCount         -- 该月份的照片总数
    FROM latest
    JOIN counts ON counts.month_key = latest.month_key
    ORDER BY
      -- 📅 排序：未知月份放最后，其他按月份倒序（最新的在前）
      CASE WHEN latest.month_key = 'unknown' THEN 1 ELSE 0 END,
      latest.month_key DESC
    LIMIT ? OFFSET ?;
  `);

  // 📊 组总数：直接对 month_key 去重计数
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT month_key) AS groupCount
    FROM images
    WHERE user_id = ?
      AND deleted_at IS NULL;
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
    WITH ranked_images AS (
      -- 为所有图片按年份分组并排序，使用窗口函数避免N+1查询
      SELECT 
        year_key,
        thumbnail_storage_key,
        image_created_at,
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
            COALESCE(image_created_at, 0) DESC,
            id DESC
        ) AS rn
      FROM images
      WHERE user_id = ?
        AND deleted_at IS NULL
    ),
    latest AS (
      -- 选择每个年份的第一张图片作为封面
      SELECT 
        year_key,
        thumbnail_storage_key,
        image_created_at,
        id,
        storage_type
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      -- 统计每个年份的图片数量
      SELECT year_key, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
        AND deleted_at IS NULL
      GROUP BY year_key
    )
    SELECT
      latest.year_key AS album_id,  -- 相册ID（统一使用 album_id，mapper 会映射为 albumId）
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
    WHERE user_id = ?
      AND deleted_at IS NULL;
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
    WITH ranked_images AS (
      -- 为所有图片按日期分组并排序，使用窗口函数避免N+1查询
      SELECT 
        date_key,
        thumbnail_storage_key,
        image_created_at,
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
            COALESCE(image_created_at, 0) DESC,
            id DESC
        ) AS rn
      FROM images
      WHERE user_id = ?
        AND deleted_at IS NULL
    ),
    latest AS (
      -- 选择每个日期的第一张图片作为封面
      SELECT 
        date_key,
        thumbnail_storage_key,
        image_created_at,
        id,
        storage_type
      FROM ranked_images
      WHERE rn = 1
    ),
    counts AS (
      -- 统计每个日期的图片数量
      SELECT date_key, COUNT(*) AS imageCount
      FROM images
      WHERE user_id = ?
        AND deleted_at IS NULL
      GROUP BY date_key
    )
    SELECT
      latest.date_key AS album_id,  -- 相册ID（统一使用 album_id，mapper 会映射为 albumId）
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
    WHERE user_id = ?
      AND deleted_at IS NULL;
  `);

  try {
    const data = dataQuery.all(userId, userId, pageSize, offset);
    const { groupCount: total } = countQuery.get(userId);
    return { data: mapFields("images", data), total };
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
  colorTheme,
}) {
  const sql = `
    UPDATE images SET 
      image_created_at = COALESCE(?, image_created_at),
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
      color_theme = COALESCE(?, color_theme)
    WHERE user_id = ? AND image_hash = ? RETURNING id
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
    colorTheme,
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
    FROM images 
    WHERE image_hash = ? AND user_id = ?
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
 * @param {boolean} [params.hasYoung] - 是否包含青少年（0-19岁，快速筛选用）
 * @param {boolean} [params.hasAdult] - 是否包含成人（20岁以上，快速筛选用）
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
 * • hasYoung和hasAdult会自动转换为0/1
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
  hasYoung,
  hasAdult,
  analysisVersion = "1.0",
}) {
  //  COALESCE 如果传入null，则不更新该字段 保持原有值
  const updateSQL = `
    UPDATE images SET 
      alt_text = COALESCE(?, alt_text),
      ocr_text = COALESCE(?, ocr_text),
      keywords = COALESCE(?, keywords),
      scene_tags = COALESCE(?, scene_tags),
      object_tags = COALESCE(?, object_tags),
      face_count = COALESCE(?, face_count),
      person_count = COALESCE(?, person_count),
      expression_tags = COALESCE(?, expression_tags),
      age_tags = COALESCE(?, age_tags),
      gender_tags = COALESCE(?, gender_tags),
      primary_expression_confidence = COALESCE(?, primary_expression_confidence),
      primary_face_quality = COALESCE(?, primary_face_quality),
      has_young = COALESCE(?, has_young),
      has_adult = COALESCE(?, has_adult),
      analysis_version = COALESCE(?, analysis_version)
    WHERE id = ?
  `;

  const stmt = db.prepare(updateSQL);
  const result = stmt.run(
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
    // 布尔值转换：true→1, false→0, null/undefined→null
    hasYoung != null ? (hasYoung ? 1 : 0) : null,
    hasAdult != null ? (hasAdult ? 1 : 0) : null,
    analysisVersion,
    imageId,
  );

  return { affectedRows: result.changes };
}

// 异步更新图片位置信息
function updateLocationInfo(imageId, { gpsLocation, country, city }) {
  const sql = `
    UPDATE images SET 
      gps_location = COALESCE(?, gps_location),
      country = COALESCE(?, country),
      city = COALESCE(?, city)
    WHERE id = ?
  `;

  const stmt = db.prepare(sql);
  const result = stmt.run(gpsLocation, country, city, imageId);

  return { affectedRows: result.changes };
}

/**
 * 👤 插入人脸特征向量数据到face_embeddings表
 *
 * 功能说明:
 * • 存储图片中每个人脸的详细信息和512维特征向量
 * • 支持人脸识别、聚类、相似度计算
 * • 采用先删除再插入策略，保证数据一致性
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
 *
 * @returns {Object} 返回对象 { affectedRows: 插入的行数 }
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
 *     confidence: 0.95
 *   }
 * ];
 * await insertFaceEmbeddings(imageId, faces);
 * ```
 */
function insertFaceEmbeddings(imageId, faceData) {
  try {
    // 先删除该图片的旧人脸数据
    // 原因：1. 避免重复数据 2. 支持重试机制 3. 确保数据一致性
    const deleteSql = `DELETE FROM face_embeddings WHERE image_id = ?`;
    const deleteStmt = db.prepare(deleteSql);
    deleteStmt.run(imageId);

    if (!faceData || faceData.length === 0) {
      return { affectedRows: 0 };
    }

    // 批量插入新的人脸数据
    const insertSql = `
      INSERT INTO face_embeddings (
        image_id, face_index, embedding, age, gender, expression, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const insertStmt = db.prepare(insertSql);

    let totalAffected = 0;
    for (const face of faceData) {
      // 将embedding数组转换为Buffer存储
      const embeddingBuffer = Buffer.from(JSON.stringify(face.embedding));

      const result = insertStmt.run(imageId, face.face_index, embeddingBuffer, face.age, face.gender, face.expression, face.confidence);
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
      storage_type
    FROM images
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
    storageType: image.storage_type,
  };
}

/**
 * 根据ID获取图片下载信息（包含 original_storage_key，用于下载）
 */
function getImageDownloadInfo({ userId, imageId }) {
  const sql = `
    SELECT 
      id,
      original_storage_key,
      high_res_storage_key,
      thumbnail_storage_key,
      storage_type
    FROM images
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
    FROM images
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

module.exports = {
  checkFileExists,
  insertImage,
  updateImageMetadata,
  updateImageSearchMetadata,
  updateLocationInfo,
  insertFaceEmbeddings,
  selectImagesByPage,
  selectImagesByYear,
  selectImagesByMonth,
  selectImagesByDate,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectGroupsByDate,
  selectHashesByUserId,
  getImageStorageInfo,
  getImageDownloadInfo,
  getImagesDownloadInfo,
};
