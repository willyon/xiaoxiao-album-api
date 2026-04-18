/**
 * 逆地理编码服务
 * 将 GPS 坐标转换为可读的位置描述
 * - 已启用且 app_config 中已保存 Key 时优先高德；失败则降级：先本地 chinaGeoDataHierarchy（GCJ），未命中再 globalGeoData（WGS）
 * - 无可用 Key：同上本地 → 全球
 */

const logger = require('../utils/logger')
const { wgs84ToGcj02 } = require('../utils/coordinateTransform')
const { getAmapApiKeyForGeocode } = require('./amapSettingsService')
const { getLocationFromCoordinatesAmap } = require('./amapReverseGeocodeService')
const { getLocationFromCoordinatesLocal } = require('./localReverseGeocodeService')
const { getLocationFromCoordinatesGlobal } = require('./globalReverseGeocodeService')

/**
 * 先中国本地行政区划（GCJ），未命中再全球国家/地区（WGS）
 * @param {number} latitude - 原始 WGS-84 纬度。
 * @param {number} longitude - 原始 WGS-84 经度。
 * @param {{lat:number,lng:number}} gcj02Coords - 转换后的 GCJ-02 坐标。
 * @param {string|null} [fallbackReason] 非空表示高德已失败，写入日志
 * @returns {{formattedAddress:string|null,country:string|null,province:string|null,city:string|null,district:string|null}|null} 位置结果。
 */
function fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, fallbackReason) {
  if (fallbackReason) {
    logger.info({
      message: '逆地理降级：使用本地数据',
      details: { reason: fallbackReason, latitude, longitude }
    })
  }

  const local = getLocationFromCoordinatesLocal(gcj02Coords.lat, gcj02Coords.lng)
  if (local) {
    logger.info({
      message: fallbackReason ? '本地行政区划逆地理编码成功（高德降级）' : '本地行政区划逆地理编码成功',
      details: {
        latitude,
        longitude,
        formattedAddress: local.formattedAddress,
        province: local.province,
        city: local.city,
        district: local.district
      }
    })
    return local
  }

  const globalLoc = getLocationFromCoordinatesGlobal(latitude, longitude)
  if (globalLoc) {
    logger.info({
      message: fallbackReason ? '本地全球国家/地区逆地理编码成功（高德降级）' : '本地全球国家/地区逆地理编码成功',
      details: {
        latitude,
        longitude,
        formattedAddress: globalLoc.formattedAddress,
        country: globalLoc.country
      }
    })
  }
  return globalLoc
}

/**
 * 照片 EXIF 经纬度为 WGS-84；返回结构化位置（与本地/全球服务字段对齐）及线上地图逆地理终态。
 * @param {number} latitude - WGS-84 纬度。
 * @param {number} longitude - WGS-84 经度。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<{
 *   location: {
 *     formattedAddress: string|null,
 *     country: string|null,
 *     province: string|null,
 *     city: string|null,
 *     district: string|null
 *   }|null,
 *   mapRegeoStatus: 'skipped'|'success'|'failed'|null
 * }>}
 */
async function getLocationFromCoordinates(latitude, longitude, userId) {
  if (!latitude || !longitude) {
    return { location: null, mapRegeoStatus: null }
  }

  const gcj02Coords = wgs84ToGcj02(longitude, latitude)

  const apiKey = getAmapApiKeyForGeocode(userId)
  if (!apiKey) {
    const location = fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, null)
    return { location, mapRegeoStatus: 'skipped' }
  }

  try {
    logger.info({
      message: '坐标转换完成',
      details: {
        original: { longitude, latitude, system: 'WGS-84' },
        converted: { longitude: gcj02Coords.lng, latitude: gcj02Coords.lat, system: 'GCJ-02' }
      }
    })

    const out = await getLocationFromCoordinatesAmap(apiKey, gcj02Coords, latitude, longitude)
    if (out.success) {
      return { location: out.result, mapRegeoStatus: 'success' }
    }
    const location = fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, out.fallbackReason)
    return { location, mapRegeoStatus: 'failed' }
  } catch (error) {
    logger.warn({
      message: '高德逆地理编码失败，尝试本地降级',
      details: { latitude, longitude, error: error.message }
    })
    const location = fallbackLocalThenGlobal(latitude, longitude, gcj02Coords, error.message)
    return { location, mapRegeoStatus: 'failed' }
  }
}

module.exports = {
  getLocationFromCoordinates
}
