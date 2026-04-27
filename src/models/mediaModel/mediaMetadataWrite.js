/**
 * 媒体元数据写模型：负责 EXIF/GPS 回写、逆地理更新与 meta 流水线终态写入。
 */
const { db } = require("../../db");
const { rebuildMediaSearchDoc } = require("./mediaSearchDocument");

/**
 * 回写媒体元数据字段（EXIF/GPS/尺寸/编码等）并置 meta 流水线为 success。
 * @param {{
 *  userId:number|string,
 *  imageHash:string,
 *  creationDate?:number|null,
 *  monthKey?:string|null,
 *  yearKey?:string|null,
 *  dateKey?:string|null,
 *  dayKey?:string|null,
 *  highResStorageKey?:string|null,
 *  originalStorageKey?:string|null,
 *  gpsLatitude?:number|null,
 *  gpsLongitude?:number|null,
 *  gpsAltitude?:number|null,
 *  gpsLocation?:string|null,
 *  country?:string|null,
 *  province?:string|null,
 *  city?:string|null,
 *  widthPx?:number|null,
 *  heightPx?:number|null,
 *  aspectRatio?:number|null,
 *  rawOrientation?:number|null,
 *  layoutType?:string|null,
 *  hdWidthPx?:number|null,
 *  hdHeightPx?:number|null,
 *  mime?:string|null,
 *  durationSec?:number|null,
 *  videoCodec?:string|null,
 *  mediaType?:'image'|'video'|null,
 *  mapRegeoStatus?:'skipped'|'success'|'failed'
 * }} params 元数据字段集合
 * @returns {{affectedRows:number,mediaId:number|null}} 更新结果
 */
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
    mediaId: result?.id || null,
  };
}

/**
 * 更新媒体位置相关字段，可选触发搜索文档重建。
 * @param {number|string} mediaId 媒体 ID
 * @param {{gpsLocation?:string|null,country?:string|null,province?:string|null,city?:string|null,mapRegeoStatus?:'skipped'|'success'|'failed'}} locationPayload 位置载荷
 * @param {{rebuildSearchArtifacts?:boolean}} [options] 可选开关
 * @returns {{affectedRows:number}} 更新结果
 */
function updateLocationInfo(mediaId, { gpsLocation, country, province, city, mapRegeoStatus }, options = {}) {
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
  locParams.push(mediaId);
  const result = stmt.run(...locParams);

  if (rebuildSearchArtifacts) {
    rebuildMediaSearchDoc(mediaId);
  }
  return { affectedRows: result.changes };
}

/**
 * 通过 userId + fileHash 更新 meta 流水线终态（success/failed）。
 * @param {{userId:number|string,imageHash:string,metaPipelineStatus:'success'|'failed'}} params 更新参数
 * @returns {{affectedRows:number}} 更新结果
 */
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

module.exports = {
  updateMediaMetadata,
  updateLocationInfo,
  updateMetaPipelineStatusByHash,
};
