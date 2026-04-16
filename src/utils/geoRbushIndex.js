/**
 * GeoJSON Feature 集合的 RBush 空间索引 + 点命中（bbox 粗筛 + booleanPointInPolygon + 多命中取最小 bbox 面积）。
 * 供 global / local 逆地理共用，避免两套相同算法分叉。
 */
const RBush = require('rbush')
const { booleanPointInPolygon } = require('@turf/boolean-point-in-polygon')

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
 * @returns {import("rbush").RBush<{ minX: number, minY: number, maxX: number, maxY: number, feature: import("geojson").Feature }>}
 */
function buildTree(features) {
  const tree = new RBush()
  const entries = []
  for (const f of features) {
    if (!f.geometry) continue
    const box = geometryBBox(f.geometry)
    if (!box) continue
    entries.push({ ...box, feature: f })
  }
  if (entries.length) {
    tree.load(entries)
  }
  return tree
}

/**
 * @param {import("rbush").RBush<any>|null} tree
 * @param {number} lng
 * @param {number} lat
 * @returns {import("geojson").Feature|null}
 */
function findHit(tree, lng, lat) {
  if (!tree) return null
  const pt = { type: 'Point', coordinates: [lng, lat] }
  const candidates = tree.search({ minX: lng, minY: lat, maxX: lng, maxY: lat })
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

module.exports = {
  buildTree,
  findHit
}
