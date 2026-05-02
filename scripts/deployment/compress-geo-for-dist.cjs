#!/usr/bin/env node
/**
 * 将打包目录内 `src/data/geo` 下的大型 GeoJSON 压成 `.json.gz` 并删除明文 `.json`，减小 rsync / 桌面包体积。
 * 运行时由 `readGeoJsonFile.js` 自动优先读 `.gz`。
 *
 * 用法：
 *   node scripts/deployment/compress-geo-for-dist.cjs [bundleRoot]
 * 默认 bundleRoot 为 `backend-dist`（与 npm run build 一致）；Electron 同步目录传 `build-resources/api-service` 等。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const GEO_FILES = ['chinaGeoDataHierarchy.json', 'globalGeoData.json']

const root = path.resolve(process.cwd(), process.argv[2] || 'backend-dist')
const geoDir = path.join(root, 'src', 'data', 'geo')

if (!fs.existsSync(geoDir) || !fs.statSync(geoDir).isDirectory()) {
  console.warn(`[compress-geo-for-dist] skip: not a directory: ${geoDir}`)
  process.exit(0)
}

for (const name of GEO_FILES) {
  const jsonPath = path.join(geoDir, name)
  if (!fs.existsSync(jsonPath)) {
    const gzOnly = path.join(geoDir, `${name}.gz`)
    if (fs.existsSync(gzOnly)) {
      console.log(`[compress-geo-for-dist] skip (already gz): ${path.relative(process.cwd(), gzOnly)}`)
    } else {
      console.warn(`[compress-geo-for-dist] missing: ${path.relative(process.cwd(), jsonPath)}`)
    }
    continue
  }
  const raw = fs.readFileSync(jsonPath)
  const gzPath = path.join(geoDir, `${name}.gz`)
  const gz = zlib.gzipSync(raw, { level: 9 })
  fs.writeFileSync(gzPath, gz)
  fs.unlinkSync(jsonPath)
  console.log(
    `[compress-geo-for-dist] ${name} → ${name}.gz  ${raw.length} → ${gz.length} bytes (${((1 - gz.length / raw.length) * 100).toFixed(1)}% smaller)`
  )
}
