/*
 * @Author: zhangshouchang
 * @Date: 2026-04-03
 * @Description: 从阿里云 DataV areas_v3 接口递归拉取省/市/区边界 GeoJSON，合并为一份新文件。
 * 省级几何来自现有 chinaGeoData.json（只读）；市、区来自在线接口。
 *
 * 用法（在项目根目录）:
 *   node scripts/development/fetch-china-geo-hierarchy.js
 *
 * 输出默认: src/data/geo/chinaGeoDataHierarchy.json
 * 可选: CHINA_GEO_OUT=/path/to/out.json node scripts/development/fetch-china-geo-hierarchy.js
 */

const fs = require('fs')
const path = require('path')

const scriptDir = path.dirname(__filename)
const projectRoot = path.resolve(scriptDir, '..', '..')
process.chdir(projectRoot)

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound'
const PROVINCE_SOURCE = path.join(projectRoot, 'src', 'data', 'geo', 'chinaGeoData.json')
const DEFAULT_OUT = path.join(projectRoot, 'src', 'data', 'geo', 'chinaGeoDataHierarchy.json')

const REQUEST_DELAY_MS = Number(process.env.CHINA_GEO_DELAY_MS || 150)
const MAX_RETRIES = Number(process.env.CHINA_GEO_RETRIES || 3)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchBoundFull(adcode) {
  const url = `${BASE_URL}/${adcode}_full.json`
  let lastErr
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'xiaoxiao-album-geo-fetch/1.0' } })
      if (res.status === 404) {
        return null
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      return await res.json()
    } catch (e) {
      lastErr = e
      await sleep(REQUEST_DELAY_MS * attempt)
    }
  }
  console.error(`  [错误] ${adcode}_full.json 失败:`, lastErr?.message || lastErr)
  return null
}

function isProvinceFeature(f) {
  const p = f?.properties
  if (!p) return false
  if (p.level === 'province') return true
  if (p.parent && p.parent.adcode === 100000) return true
  return false
}

async function main() {
  const outPath = process.env.CHINA_GEO_OUT ? path.resolve(process.env.CHINA_GEO_OUT) : DEFAULT_OUT

  if (!fs.existsSync(PROVINCE_SOURCE)) {
    console.error('找不到省级数据源:', PROVINCE_SOURCE)
    process.exit(1)
  }

  const raw = JSON.parse(fs.readFileSync(PROVINCE_SOURCE, 'utf8'))
  const provinceFeatures = (raw.features || []).filter(isProvinceFeature)
  if (provinceFeatures.length === 0) {
    console.error('chinaGeoData.json 中未解析到省级 Feature，请检查文件结构。')
    process.exit(1)
  }

  const cityFeatures = []
  const districtFeatures = []
  const citySeen = new Set()
  const districtSeen = new Set()

  const pushCity = (f) => {
    const ad = f?.properties?.adcode
    if (ad == null || citySeen.has(ad)) return
    citySeen.add(ad)
    cityFeatures.push(f)
  }

  const pushDistrict = (f) => {
    const ad = f?.properties?.adcode
    if (ad == null || districtSeen.has(ad)) return
    districtSeen.add(ad)
    districtFeatures.push(f)
  }

  console.log(`省级条目: ${provinceFeatures.length}，请求间隔 ${REQUEST_DELAY_MS}ms，输出: ${outPath}\n`)

  for (let i = 0; i < provinceFeatures.length; i++) {
    const pf = provinceFeatures[i]
    const padcode = pf.properties.adcode
    const pname = pf.properties.name || String(padcode)
    console.log(`[${i + 1}/${provinceFeatures.length}] 省/直辖市: ${pname} (${padcode})`)

    const provinceFull = await fetchBoundFull(padcode)
    await sleep(REQUEST_DELAY_MS)

    if (!provinceFull || !Array.isArray(provinceFull.features)) {
      console.warn(`  跳过（无数据或 404）: ${padcode}`)
      continue
    }

    const citiesInProvince = []

    for (const f of provinceFull.features) {
      const lvl = f?.properties?.level
      if (lvl === 'city') {
        pushCity(f)
        citiesInProvince.push(f)
      } else if (lvl === 'district') {
        pushDistrict(f)
      }
    }

    for (let j = 0; j < citiesInProvince.length; j++) {
      const cf = citiesInProvince[j]
      const cadcode = cf.properties.adcode
      const cname = cf.properties.name || String(cadcode)
      process.stdout.write(`  市 ${j + 1}/${citiesInProvince.length}: ${cname} (${cadcode}) … `)

      const cityFull = await fetchBoundFull(cadcode)
      await sleep(REQUEST_DELAY_MS)

      if (!cityFull || !Array.isArray(cityFull.features)) {
        console.log('跳过')
        continue
      }

      let n = 0
      for (const f of cityFull.features) {
        if (f?.properties?.level === 'district') {
          pushDistrict(f)
          n++
        }
      }
      console.log(`区 ${n}`)
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sources: {
      provincesFile: 'src/data/geo/chinaGeoData.json',
      boundBaseUrl: `${BASE_URL}/:adcode_full.json`
    },
    province: {
      type: 'FeatureCollection',
      features: provinceFeatures
    },
    city: {
      type: 'FeatureCollection',
      features: cityFeatures
    },
    district: {
      type: 'FeatureCollection',
      features: districtFeatures
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(output), 'utf8')

  console.log('\n完成。')
  console.log(`  省: ${provinceFeatures.length}，市: ${cityFeatures.length}，区: ${districtFeatures.length}`)
  console.log(`  已写入: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
