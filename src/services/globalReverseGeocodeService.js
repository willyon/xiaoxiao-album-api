/**
 * 境外国家/地区逆地理（globalGeoData.json，Natural Earth Admin-0）
 * 边界为 CRS84（与 EXIF 的 WGS-84 一致）。
 * 入参必须为 **WGS-84**（勿与 GCJ-02 混用）：`geocodingService` 在中国区划未命中后兜底调用时传入原始经纬度。
 * 仅用于中国行政区划未命中时的兜底：返回国家/地区展示名（优先中文，否则英文）。
 */

const fs = require('fs')
const path = require('path')
const RBush = require('rbush')
const { booleanPointInPolygon } = require('@turf/boolean-point-in-polygon')
const logger = require('../utils/logger')

const GLOBAL_PATH = path.join(__dirname, '..', 'data', 'geo', 'globalGeoData.json')

let indexReady = false
/** @type {Error|null} */
let indexError = null
/** @type {RBush|null} */
let tree = null

function walkCoords(coords, cb) {
  if (!coords || typeof coords !== 'object') return
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    cb(coords[0], coords[1])
    return
  }
  for (let i = 0; i < coords.length; i++) {
    walkCoords(coords[i], cb)
  }
}

/**
 * @param {import("geojson").Geometry} geometry
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
function geometryBBox(geometry) {
  if (!geometry || !geometry.coordinates) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  walkCoords(geometry.coordinates, (x, y) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  })
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

function bboxArea(b) {
  return (b.maxX - b.minX) * (b.maxY - b.minY)
}

/**
 * @param {import("geojson").Feature[]} features
 */
function buildTree(features) {
  const t = new RBush()
  const entries = []
  for (const f of features) {
    if (!f.geometry) continue
    const box = geometryBBox(f.geometry)
    if (!box) continue
    entries.push({ ...box, feature: f })
  }
  if (entries.length) {
    t.load(entries)
  }
  return t
}

function ensureIndex() {
  if (indexReady || indexError) return
  try {
    if (!fs.existsSync(GLOBAL_PATH)) {
      throw new Error(`文件不存在: ${GLOBAL_PATH}`)
    }
    const raw = fs.readFileSync(GLOBAL_PATH, 'utf8')
    const data = JSON.parse(raw)
    const features = data.features || []
    tree = buildTree(features)
    indexReady = true
    logger.info({
      message: '全球国家/地区逆地理索引已构建',
      details: { path: GLOBAL_PATH, features: features.length }
    })
  } catch (e) {
    indexError = e
    logger.error({
      message: '加载 globalGeoData.json 失败，境外逆地理不可用',
      details: { error: e.message, path: GLOBAL_PATH }
    })
  }
}

/**
 * @param {RBush|null} t
 * @param {number} lng
 * @param {number} lat
 * @returns {import("geojson").Feature|null}
 */
function findHit(t, lng, lat) {
  if (!t) return null
  const pt = { type: 'Point', coordinates: [lng, lat] }
  const candidates = t.search({ minX: lng, minY: lat, maxX: lng, maxY: lat })
  let best = null
  let bestArea = Infinity
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i]
    try {
      if (booleanPointInPolygon(pt, item.feature.geometry)) {
        const area = bboxArea(item)
        if (area < bestArea) {
          bestArea = area
          best = item.feature
        }
      }
    } catch {
      /* 跳过异常几何 */
    }
  }
  return best
}

/**
 * @param {{ name?: string, nameZh?: string|null }} props
 * @returns {string|null}
 */
function displayCountryName(props) {
  if (!props) return null
  const zh = props.nameZh
  if (zh != null && String(zh).trim() !== '') {
    return String(zh).trim()
  }
  const en = props.name
  if (en != null && String(en).trim() !== '') {
    return String(en).trim()
  }
  return null
}

/**
 * @param {number} latitude WGS-84 纬度
 * @param {number} longitude WGS-84 经度
 * @returns {{
 *   formattedAddress: string|null,
 *   country: string|null,
 *   province: null,
 *   city: null,
 *   district: null
 * }|null}
 */
function getLocationFromCoordinatesGlobal(latitude, longitude) {
  ensureIndex()
  if (!indexReady) {
    return null
  }

  const lng = longitude
  const lat = latitude
  const hit = findHit(tree, lng, lat)
  if (!hit) {
    logger.info({
      message: '全球逆地理未命中任何国家/地区（可能位于公海等）',
      details: { lng, lat }
    })
    return null
  }

  const label = displayCountryName(hit.properties || {})
  if (!label) {
    return null
  }

  return {
    formattedAddress: label,
    country: label,
    province: null,
    city: null,
    district: null
  }
}

module.exports = {
  getLocationFromCoordinatesGlobal
}
