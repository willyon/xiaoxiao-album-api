/*
 * @Author: zhangshouchang
 * @Date: 2025-01-07
 * @Description: 数据库字段映射工具 - 在数据库字段（下划线）和API字段（驼峰）之间转换
 */

/**
 * 字段映射配置
 * 定义数据库字段名到API字段名的映射关系
 */
const FIELD_MAPPING = {
  // users表字段映射
  users: {
    verified_status: 'verifiedStatus',
    verification_token: 'verificationToken',
    created_at: 'createdAt'
  },

  // albums表字段映射
  albums: {
    id: 'albumId',
    user_id: 'userId',
    name: 'name',
    description: 'description',
    cover_image_id: 'coverImageId',
    cover_media_id: 'coverImageId',
    media_count: 'mediaCount',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    last_used_at: 'lastUsedAt',
    deleted_at: 'deletedAt'
  },

  // media表字段映射（重构后主表）
  media: {
    id: 'mediaId',
    original_storage_key: 'originalStorageKey',
    high_res_storage_key: 'highResStorageKey',
    thumbnail_storage_key: 'thumbnailStorageKey',
    captured_at: 'capturedAt',
    created_at: 'createdAt',
    year_key: 'yearKey',
    month_key: 'monthKey',
    date_key: 'dateKey',
    day_key: 'dayKey',
    album_id: 'albumId',
    gps_latitude: 'gpsLatitude',
    gps_longitude: 'gpsLongitude',
    gps_altitude: 'gpsAltitude',
    gps_location: 'gpsLocation',
    file_size_bytes: 'fileSizeBytes',
    file_hash: 'fileHash',
    width_px: 'widthPx',
    height_px: 'heightPx',
    aspect_ratio: 'aspectRatio',
    raw_orientation: 'rawOrientation',
    hd_width_px: 'hdWidthPx',
    hd_height_px: 'hdHeightPx',
    mime: 'mime',
    country: 'country',
    province: 'province',
    city: 'city',
    is_favorite: 'isFavorite',
    media_type: 'mediaType',
    duration_sec: 'durationSec',
    video_codec: 'videoCodec',
    person_count: 'personCount',
    face_count: 'faceCount',
    expression_tags: 'expressionTags',
    age_tags: 'ageTags',
    gender_tags: 'genderTags',
    is_blurry: 'isBlurry',
    aesthetic_score: 'aestheticScore',
    sharpness_score: 'sharpnessScore',
    preferred_face_quality: 'preferredFaceQuality',
    ai_description: 'aiDescription',
    ai_keywords_json: 'aiKeywordsJson',
    ai_subject_tags_json: 'aiSubjectTagsJson',
    ai_action_tags_json: 'aiActionTagsJson',
    ai_scene_tags_json: 'aiSceneTagsJson',
    ai_ocr: 'aiOcr'
  }
}

/**
 * 将下划线字段名转换为驼峰字段名（备用方法）
 * @param {string} snakeCase - 下划线格式的字段名。
 * @returns {string} 驼峰格式的字段名。
 */
function snakeToCamel(snakeCase) {
  return snakeCase.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase())
}

/**
 * 将数据库查询结果转换为API格式（优化版）
 * @param {string} tableName - 表名。
 * @param {object|Array<object>} data - 数据库查询结果。
 * @returns {object|Array<object>} API 格式数据。
 */
function mapFields(tableName, data) {
  // 如果没有数据，直接返回
  if (!data) return data

  // 获取映射配置
  const mapping = FIELD_MAPPING[tableName]
  if (!mapping) {
    return data
  }

  // 处理数组
  if (Array.isArray(data)) {
    return data.map((item) => mapFields(tableName, item))
  }

  // 处理对象
  if (typeof data === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(data)) {
      // 使用预定义的映射，如果没有则使用通用转换
      const mappedKey = mapping[key] || snakeToCamel(key)
      result[mappedKey] = value
    }
    return result
  }

  return data
}

module.exports = {
  mapFields
}
