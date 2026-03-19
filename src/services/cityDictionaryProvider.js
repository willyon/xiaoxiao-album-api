/*
 * @Description: 城市词典提供器
 * 基础城市集合只来自 media.city。
 */
const { db } = require("./database");
const { uniqueTerms } = require("../utils/querySemanticMatcher");

let cachedCityDictionary = null;

function listDistinctMediaCities() {
  const rows = db
    .prepare(
      `SELECT DISTINCT TRIM(city) AS city
     FROM media
     WHERE city IS NOT NULL AND TRIM(city) != ''
     ORDER BY TRIM(city) COLLATE NOCASE ASC`,
    )
    .all();
  return rows.map((row) => String(row.city || "").trim()).filter(Boolean);
}

function buildCityDictionaryFromMedia() {
  const dbCities = listDistinctMediaCities();
  if (dbCities.length === 0) return [];

  return dbCities
    .map((city) => ({
      label: city,
      aliases: [],
      filterValues: [city],
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
}

function refreshCityDictionary() {
  cachedCityDictionary = buildCityDictionaryFromMedia();
  return cachedCityDictionary;
}

/** 仅冷启动时读请求会触发刷新；之后由 cityDictionaryScheduler 去抖更新。 */
function getCityDictionary() {
  if (!Array.isArray(cachedCityDictionary)) {
    try {
      return refreshCityDictionary();
    } catch (error) {
      if (Array.isArray(cachedCityDictionary) && cachedCityDictionary.length > 0) {
        return cachedCityDictionary;
      }
      return [];
    }
  }
  return cachedCityDictionary;
}

module.exports = {
  getCityDictionary,
  refreshCityDictionary,
};
