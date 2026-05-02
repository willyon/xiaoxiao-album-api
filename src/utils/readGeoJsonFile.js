/**
 * 读取 `data/geo` 下的大型 GeoJSON：优先 `*.json.gz`（打包产物），否则 `*.json`（开发机源码目录）。
 * 解压与解析均为无损，与直接读 `.json` 等价。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

/**
 * @param {string} geoDir `…/data/geo` 目录绝对路径
 * @param {string} baseFileName 如 `chinaGeoDataHierarchy.json`
 * @returns {{ data: unknown, pathUsed: string }}
 */
function readGeoJsonParsed(geoDir, baseFileName) {
  const gzPath = path.join(geoDir, `${baseFileName}.gz`)
  const jsonPath = path.join(geoDir, baseFileName)
  if (fs.existsSync(gzPath)) {
    const buf = zlib.gunzipSync(fs.readFileSync(gzPath))
    return { data: JSON.parse(buf.toString('utf8')), pathUsed: gzPath }
  }
  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, 'utf8')
    return { data: JSON.parse(raw), pathUsed: jsonPath }
  }
  throw new Error(`缺少 ${baseFileName} 或 ${baseFileName}.gz：${geoDir}`)
}

module.exports = {
  readGeoJsonParsed
}
