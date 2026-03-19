/*
 * @Description: 查询地点解析工具
 */
const { getCityDictionary } = require("../services/cityDictionaryProvider");
const { uniqueTerms, collectMatches } = require("./querySemanticMatcher");

function collectCitySignals(normalizedQuery) {
  return collectMatches(normalizedQuery, getCityDictionary());
}

function buildLocationFilter(cities) {
  const values = uniqueTerms((cities || []).flatMap((city) => city.filterValues || [city.label]));
  return values.length > 0 ? { location: values } : null;
}

module.exports = {
  collectCitySignals,
  buildLocationFilter,
};
