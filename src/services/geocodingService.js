/**
 * 逆地理编码服务
 * 将 GPS 坐标转换为可读的位置描述
 * - 配置了 AMAP_API_KEY 时优先高德（amapReverseGeocodeService）；失败则降级：先本地 chinaGeoDataHierarchy（GCJ），未命中再 globalGeoData（WGS）
 * - 未配置高德：同上本地 → 全球
 */

const logger = require("../utils/logger");
const { wgs84ToGcj02 } = require("../utils/coordinateTransform");
const { getLocationFromCoordinatesAmap } = require("./amapReverseGeocodeService");
const { getLocationFromCoordinatesLocal } = require("./localReverseGeocodeService");
const { getLocationFromCoordinatesGlobal } = require("./globalReverseGeocodeService");

/**
 * 先中国本地行政区划（GCJ），未命中再全球国家/地区（WGS）
 * @param {string|null} [fallbackReason] 非空表示高德已失败，写入日志
 */
function fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, fallbackReason) {
  if (fallbackReason) {
    logger.info({
      message: "逆地理降级：使用本地数据",
      details: { reason: fallbackReason, latitude, longitude },
    });
  }

  const local = getLocationFromCoordinatesLocal(gcj02Coords.lat, gcj02Coords.lng);
  if (local) {
    logger.info({
      message: fallbackReason ? "本地行政区划逆地理编码成功（高德降级）" : "本地行政区划逆地理编码成功",
      details: {
        latitude,
        longitude,
        formattedAddress: local.formattedAddress,
        province: local.province,
        city: local.city,
        district: local.district,
      },
    });
    return local;
  }

  const globalLoc = getLocationFromCoordinatesGlobal(latitude, longitude);
  if (globalLoc) {
    logger.info({
      message: fallbackReason ? "本地全球国家/地区逆地理编码成功（高德降级）" : "本地全球国家/地区逆地理编码成功",
      details: {
        latitude,
        longitude,
        formattedAddress: globalLoc.formattedAddress,
        country: globalLoc.country,
      },
    });
  }
  return globalLoc;
}

/**
 * 照片 EXIF 经纬度为 WGS-84；返回结构化位置（与本地/全球服务字段对齐）。
 * @returns {Promise<{
 *   formattedAddress: string|null,
 *   country: string|null,
 *   province: string|null,
 *   city: string|null,
 *   district: string|null
 * }|null>}
 */
async function getLocationFromCoordinates(latitude, longitude) {
  if (!latitude || !longitude) {
    return null;
  }

  const gcj02Coords = wgs84ToGcj02(longitude, latitude);

  const apiKey = (process.env.AMAP_API_KEY || "").trim();
  if (!apiKey) {
    return fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, null);
  }

  try {
    logger.info({
      message: "坐标转换完成",
      details: {
        original: { longitude, latitude, system: "WGS-84" },
        converted: { longitude: gcj02Coords.lng, latitude: gcj02Coords.lat, system: "GCJ-02" },
      },
    });

    const out = await getLocationFromCoordinatesAmap(apiKey, gcj02Coords, latitude, longitude);
    if (out.success) {
      return out.result;
    }
    return fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, out.fallbackReason);
  } catch (error) {
    logger.warn({
      message: "高德逆地理编码失败，尝试本地降级",
      details: { latitude, longitude, error: error.message },
    });
    return fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, error.message);
  }
}

module.exports = {
  getLocationFromCoordinates,
};
