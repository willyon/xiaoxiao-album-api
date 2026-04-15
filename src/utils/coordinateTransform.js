/**
 * 坐标系统转换工具
 * 支持 WGS-84 与 GCJ-02 坐标系之间的转换
 *
 * 坐标系说明：
 * - WGS-84: GPS原始坐标系，国际标准
 * - GCJ-02: 中国国家测绘局坐标系（火星坐标系），高德、腾讯地图使用
 * - BD-09: 百度坐标系，百度地图使用
 */

const PI = Math.PI
const A = 6378245.0 // 长半轴
const EE = 0.00669342162296594323 // 偏心率平方

/**
 * 判断坐标是否在中国境内
 * @param {number} lng - 经度
 * @param {number} lat - 纬度
 * @returns {boolean} 是否在中国境内
 */
function isInChina(lng, lat) {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}

/**
 * 转换纬度
 * @param {number} lng - 经度
 * @param {number} lat - 纬度
 * @returns {number} 转换后的纬度偏移
 */
function transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng))
  ret += ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(lat * PI) + 40.0 * Math.sin((lat / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((lat / 12.0) * PI) + 320 * Math.sin((lat * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

/**
 * 转换经度
 * @param {number} lng - 经度
 * @param {number} lat - 纬度
 * @returns {number} 转换后的经度偏移
 */
function transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng))
  ret += ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(lng * PI) + 40.0 * Math.sin((lng / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((lng / 12.0) * PI) + 300.0 * Math.sin((lng / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

/**
 * WGS-84 转 GCJ-02
 * @param {number} wgsLng - WGS-84经度
 * @param {number} wgsLat - WGS-84纬度
 * @returns {Object} GCJ-02坐标 {lng, lat}
 */
function wgs84ToGcj02(wgsLng, wgsLat) {
  if (!isInChina(wgsLng, wgsLat)) {
    // 不在中国境内，直接返回原坐标
    return { lng: wgsLng, lat: wgsLat }
  }

  let dLat = transformLat(wgsLng - 105.0, wgsLat - 35.0)
  let dLng = transformLng(wgsLng - 105.0, wgsLat - 35.0)

  const radLat = (wgsLat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)

  const gcjLat = wgsLat + dLat
  const gcjLng = wgsLng + dLng

  return { lng: gcjLng, lat: gcjLat }
}

/**
 * GCJ-02 转 WGS-84
 * @param {number} gcjLng - GCJ-02经度
 * @param {number} gcjLat - GCJ-02纬度
 * @returns {Object} WGS-84坐标 {lng, lat}
 */
function gcj02ToWgs84(gcjLng, gcjLat) {
  if (!isInChina(gcjLng, gcjLat)) {
    // 不在中国境内，直接返回原坐标
    return { lng: gcjLng, lat: gcjLat }
  }

  let dLat = transformLat(gcjLng - 105.0, gcjLat - 35.0)
  let dLng = transformLng(gcjLng - 105.0, gcjLat - 35.0)

  const radLat = (gcjLat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)

  const wgsLat = gcjLat - dLat
  const wgsLng = gcjLng - dLng

  return { lng: wgsLng, lat: wgsLat }
}

/**
 * GCJ-02 转 BD-09
 * @param {number} gcjLng - GCJ-02经度
 * @param {number} gcjLat - GCJ-02纬度
 * @returns {Object} BD-09坐标 {lng, lat}
 */
function gcj02ToBd09(gcjLng, gcjLat) {
  const z = Math.sqrt(gcjLng * gcjLng + gcjLat * gcjLat) + 0.00002 * Math.sin((gcjLat * PI * 3000.0) / 180.0)
  const theta = Math.atan2(gcjLat, gcjLng) + 0.000003 * Math.cos((gcjLng * PI * 3000.0) / 180.0)

  const bdLng = z * Math.cos(theta) + 0.0065
  const bdLat = z * Math.sin(theta) + 0.006

  return { lng: bdLng, lat: bdLat }
}

/**
 * BD-09 转 GCJ-02
 * @param {number} bdLng - BD-09经度
 * @param {number} bdLat - BD-09纬度
 * @returns {Object} GCJ-02坐标 {lng, lat}
 */
function bd09ToGcj02(bdLng, bdLat) {
  const x = bdLng - 0.0065
  const y = bdLat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin((y * PI * 3000.0) / 180.0)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos((x * PI * 3000.0) / 180.0)

  const gcjLng = z * Math.cos(theta)
  const gcjLat = z * Math.sin(theta)

  return { lng: gcjLng, lat: gcjLat }
}

/**
 * WGS-84 转 BD-09
 * @param {number} wgsLng - WGS-84经度
 * @param {number} wgsLat - WGS-84纬度
 * @returns {Object} BD-09坐标 {lng, lat}
 */
function wgs84ToBd09(wgsLng, wgsLat) {
  const gcj = wgs84ToGcj02(wgsLng, wgsLat)
  return gcj02ToBd09(gcj.lng, gcj.lat)
}

/**
 * BD-09 转 WGS-84
 * @param {number} bdLng - BD-09经度
 * @param {number} bdLat - BD-09纬度
 * @returns {Object} WGS-84坐标 {lng, lat}
 */
function bd09ToWgs84(bdLng, bdLat) {
  const gcj = bd09ToGcj02(bdLng, bdLat)
  return gcj02ToWgs84(gcj.lng, gcj.lat)
}

module.exports = {
  wgs84ToGcj02,
  gcj02ToWgs84,
  gcj02ToBd09,
  bd09ToGcj02,
  wgs84ToBd09,
  bd09ToWgs84,
  isInChina
}
