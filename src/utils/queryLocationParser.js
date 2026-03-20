/*
 * @Description: 查询地点解析工具
 */
const { CITY_DICTIONARY } = require("../config/searchSemanticDictionary");
const { uniqueTerms, collectMatches } = require("./querySemanticMatcher");

function collectCitySignals(normalizedQuery) {
  return collectMatches(normalizedQuery, CITY_DICTIONARY);
}

function buildLocationFilter(cities) {
  const values = uniqueTerms((cities || []).map((city) => city.label).filter(Boolean));
  return values.length > 0 ? { location: values } : null;
}

module.exports = {
  collectCitySignals,
  buildLocationFilter,
};
