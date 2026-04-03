/**
 * 本地行政区划逆地理编码（chinaGeoDataHierarchy.json）
 * 边界数据为 GCJ-02；入参须为 GCJ-02（由 geocodingService 对 EXIF 的 WGS-84 转换后再传入）。
 * 使用 RBush（bbox）粗筛 + Turf booleanPointInPolygon 精确判断。
 *
 * 数据精度：仅含省 / 市 / 区县（县级）行政区划边界，**最细到区县**；无街道、乡镇、兴趣点等更细粒度。
 * 命中时尽量返回区县；未命中则降级为市或省。
 */

const fs = require("fs");
const path = require("path");
const RBush = require("rbush");
const { booleanPointInPolygon } = require("@turf/boolean-point-in-polygon");
const logger = require("../utils/logger");

const HIERARCHY_PATH = path.join(__dirname, "..", "data", "geo", "chinaGeoDataHierarchy.json");

const MUNICIPALITY_ADCODES = new Set([110000, 120000, 310000, 500000]);

let indexReady = false;
/** @type {Error|null} */
let indexError = null;
/** @type {RBush|null} */
let treeDistrict = null;
/** @type {RBush|null} */
let treeCity = null;
/** @type {RBush|null} */
let treeProvince = null;
/** @type {Map<number, string>} */
let adcodeToName = new Map();

/**
 * @param {unknown} coords
 * @param {(lng: number, lat: number) => void} cb
 */
function walkCoords(coords, cb) {
  if (!coords || typeof coords !== "object") return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    cb(coords[0], coords[1]);
    return;
  }
  for (let i = 0; i < coords.length; i++) {
    walkCoords(coords[i], cb);
  }
}

/**
 * @param {import("geojson").Geometry} geometry
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
function geometryBBox(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walkCoords(geometry.coordinates, (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function bboxArea(b) {
  return (b.maxX - b.minX) * (b.maxY - b.minY);
}

/**
 * @param {import("geojson").Feature[]} features
 */
function buildTree(features) {
  const tree = new RBush();
  const entries = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const box = geometryBBox(f.geometry);
    if (!box) continue;
    entries.push({ ...box, feature: f });
  }
  if (entries.length) {
    tree.load(entries);
  }
  return tree;
}

function ensureIndex() {
  if (indexReady || indexError) return;
  try {
    if (!fs.existsSync(HIERARCHY_PATH)) {
      throw new Error(`文件不存在: ${HIERARCHY_PATH}`);
    }
    const raw = fs.readFileSync(HIERARCHY_PATH, "utf8");
    const data = JSON.parse(raw);

    adcodeToName = new Map();
    for (const level of ["province", "city", "district"]) {
      const fc = data[level];
      if (!fc?.features) continue;
      for (const f of fc.features) {
        const ad = f.properties?.adcode;
        if (ad != null) {
          adcodeToName.set(Number(ad), f.properties.name || "");
        }
      }
    }

    treeProvince = buildTree(data.province?.features || []);
    treeCity = buildTree(data.city?.features || []);
    treeDistrict = buildTree(data.district?.features || []);

    indexReady = true;
    logger.info({
      message: "本地行政区划逆地理索引已构建",
      details: {
        path: HIERARCHY_PATH,
        provinces: data.province?.features?.length ?? 0,
        cities: data.city?.features?.length ?? 0,
        districts: data.district?.features?.length ?? 0,
      },
    });
  } catch (e) {
    indexError = e;
    logger.error({
      message: "加载 chinaGeoDataHierarchy.json 失败，本地逆地理不可用",
      details: { error: e.message, path: HIERARCHY_PATH },
    });
  }
}

/**
 * @param {RBush|null} tree
 * @param {number} lng GCJ-02
 * @param {number} lat GCJ-02
 * @returns {import("geojson").Feature|null}
 */
function findHit(tree, lng, lat) {
  if (!tree) return null;
  const pt = { type: "Point", coordinates: [lng, lat] };
  const candidates = tree.search({ minX: lng, minY: lat, maxX: lng, maxY: lat });
  let best = null;
  let bestArea = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    try {
      if (booleanPointInPolygon(pt, item.feature.geometry)) {
        const area = bboxArea(item);
        if (area < bestArea) {
          bestArea = area;
          best = item.feature;
        }
      }
    } catch (_e) {
      /* 跳过异常几何 */
    }
  }
  return best;
}

/**
 * @param {import("geojson").Feature} f
 */
function buildResultFromDistrict(f) {
  const p = f.properties;
  const district = p.name || null;
  const routes = p.acroutes || [];
  const provinceAd = routes.length >= 2 ? Number(routes[1]) : null;
  const provinceName = provinceAd != null ? adcodeToName.get(provinceAd) || null : null;
  const parentAd = p.parent?.adcode != null ? Number(p.parent.adcode) : null;
  let cityName = null;
  if (parentAd != null) {
    if (MUNICIPALITY_ADCODES.has(parentAd)) {
      cityName = provinceName;
    } else {
      cityName = adcodeToName.get(parentAd) || null;
    }
  }
  const parts =
    provinceName && cityName && provinceName === cityName
      ? [provinceName, district].filter(Boolean)
      : [provinceName, cityName, district].filter(Boolean);
  const formattedAddress = parts.length ? parts.join("") : null;
  return {
    formattedAddress,
    country: "中国",
    province: provinceName,
    city: cityName || provinceName,
    district,
  };
}

/**
 * @param {import("geojson").Feature} f
 */
function buildResultFromCity(f) {
  const p = f.properties;
  const cityName = p.name || null;
  const provinceAd = p.parent?.adcode != null ? Number(p.parent.adcode) : null;
  const provinceName = provinceAd != null ? adcodeToName.get(provinceAd) || null : null;
  const parts = [provinceName, cityName].filter(Boolean);
  const formattedAddress = parts.length ? parts.join("") : null;
  return {
    formattedAddress,
    country: "中国",
    province: provinceName,
    city: cityName || provinceName,
    district: null,
  };
}

/**
 * @param {import("geojson").Feature} f
 */
function buildResultFromProvince(f) {
  const p = f.properties;
  const provinceName = p.name || null;
  const ad = Number(p.adcode);
  const isMunicipality = MUNICIPALITY_ADCODES.has(ad);
  return {
    formattedAddress: provinceName,
    country: "中国",
    province: provinceName,
    city: isMunicipality ? provinceName : null,
    district: null,
  };
}

/**
 * 返回的 formattedAddress 最细为省/市/区（县）组合，无街道、乡镇或 POI。
 *
 * @param {number} latitude GCJ-02 纬度
 * @param {number} longitude GCJ-02 经度
 * @returns {{
 *   formattedAddress: string|null,
 *   country: string|null,
 *   province: string|null,
 *   city: string|null,
 *   district: string|null
 * }|null}
 */
function getLocationFromCoordinatesLocal(latitude, longitude) {
  ensureIndex();
  if (!indexReady) {
    return null;
  }

  const lng = longitude;
  const lat = latitude;

  let hit = findHit(treeDistrict, lng, lat);
  if (hit) {
    return buildResultFromDistrict(hit);
  }

  hit = findHit(treeCity, lng, lat);
  if (hit) {
    return buildResultFromCity(hit);
  }

  hit = findHit(treeProvince, lng, lat);
  if (hit) {
    return buildResultFromProvince(hit);
  }

  logger.info({
    message: "本地逆地理未命中任何行政区划",
    details: { gcj02: { lng, lat } },
  });
  return null;
}

module.exports = {
  getLocationFromCoordinatesLocal,
};
