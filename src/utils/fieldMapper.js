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
    verified_status: "verifiedStatus",
    verification_token: "verificationToken",
    created_at: "createdAt",
  },

  // images表字段映射
  images: {
    id: "imageId", // 图片ID映射为 imageId
    original_storage_key: "originalStorageKey",
    high_res_storage_key: "highResStorageKey",
    thumbnail_storage_key: "thumbnailStorageKey",
    image_created_at: "creationDate",
    created_at: "createdAt", // 缩略图入库时间（毫秒）
    year_key: "yearKey",
    month_key: "monthKey",
    date_key: "dateKey",
    day_key: "dayKey",
    album_id: "albumId", // 统一映射：album_id -> albumId（时间相册的 albumId 就是 year_key/month_key/date_key）
    gps_latitude: "gpsLatitude",
    gps_longitude: "gpsLongitude",
    gps_altitude: "gpsAltitude",
    gps_location: "gpsLocation",
    storage_type: "storageType",
    file_size_bytes: "fileSizeBytes",
    image_hash: "imageHash",
    width_px: "widthPx",
    height_px: "heightPx",
    aspect_ratio: "aspectRatio",
    raw_orientation: "rawOrientation",
    layout_type: "layoutType",
    hd_width_px: "hdWidthPx",
    hd_height_px: "hdHeightPx",
    thumb_width_px: "thumbWidthPx",
    thumb_height_px: "thumbHeightPx",
    mime: "mime",
    country: "country",
    city: "city",
    person_count: "personCount", // 新增：人物数量（YOLOv10检测）
    added_at: "addedAt", // 添加到相册的时间
    is_favorite: "isFavorite", // 是否已喜欢
    is_blurry: "isBlurry", // 是否模糊图（清理用）
    media_type: "mediaType", // 'image' | 'video'
    duration_sec: "durationSec", // 视频时长（秒）
    video_codec: "videoCodec", // 视频编码
  },

  // albums表字段映射
  albums: {
    id: "albumId",
    user_id: "userId",
    name: "name",
    description: "description",
    cover_image_id: "coverImageId",
    cover_media_id: "coverImageId",
    image_count: "imageCount",
    created_at: "createdAt",
    updated_at: "updatedAt",
    last_used_at: "lastUsedAt",
    deleted_at: "deletedAt",
  },

  // media表字段映射（重构后主表）
  media: {
    id: "mediaId",
    original_storage_key: "originalStorageKey",
    high_res_storage_key: "highResStorageKey",
    thumbnail_storage_key: "thumbnailStorageKey",
    captured_at: "capturedAt",
    created_at: "createdAt",
    year_key: "yearKey",
    month_key: "monthKey",
    date_key: "dateKey",
    day_key: "dayKey",
    album_id: "albumId",
    gps_latitude: "gpsLatitude",
    gps_longitude: "gpsLongitude",
    gps_altitude: "gpsAltitude",
    gps_location: "gpsLocation",
    storage_type: "storageType",
    file_size_bytes: "fileSizeBytes",
    file_hash: "fileHash",
    width_px: "widthPx",
    height_px: "heightPx",
    aspect_ratio: "aspectRatio",
    raw_orientation: "rawOrientation",
    layout_type: "layoutType",
    hd_width_px: "hdWidthPx",
    hd_height_px: "hdHeightPx",
    mime: "mime",
    country: "country",
    city: "city",
    is_favorite: "isFavorite",
    media_type: "mediaType",
    duration_sec: "durationSec",
    video_codec: "videoCodec",
  },
};

/**
 * 将下划线字段名转换为驼峰字段名（备用方法）
 * @param {string} snakeCase - 下划线格式的字段名
 * @returns {string} 驼峰格式的字段名
 */
function snakeToCamel(snakeCase) {
  return snakeCase.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * 将数据库查询结果转换为API格式（优化版）
 * @param {string} tableName - 表名
 * @param {Object|Array} data - 数据库查询结果
 * @returns {Object|Array} API格式的数据
 */
function mapFields(tableName, data) {
  // 如果没有数据，直接返回
  if (!data) return data;

  // 获取映射配置
  const mapping = FIELD_MAPPING[tableName];
  if (!mapping) {
    // 如果没有配置映射，使用通用转换
    return mapGenericFields(data);
  }

  // 处理数组
  if (Array.isArray(data)) {
    return data.map((item) => mapFields(tableName, item));
  }

  // 处理对象
  if (typeof data === "object") {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      // 使用预定义的映射，如果没有则使用通用转换
      const mappedKey = mapping[key] || snakeToCamel(key);
      result[mappedKey] = value;
    }
    return result;
  }

  return data;
}

/**
 * 通用字段映射（用于没有预定义映射的表）
 * @param {Object|Array} data - 数据
 * @returns {Object|Array} 转换后的数据
 */
function mapGenericFields(data) {
  if (Array.isArray(data)) {
    return data.map((item) => mapGenericFields(item));
  }

  if (data && typeof data === "object") {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      const camelKey = snakeToCamel(key);
      result[camelKey] = value;
    }
    return result;
  }

  return data;
}

module.exports = {
  mapFields,
  FIELD_MAPPING,
};
