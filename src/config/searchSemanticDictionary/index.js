/*
 * @Description: 中文场景搜索语义词典统一导出（时间与地点结构化解析）
 */

const TIME_SIGNAL_TERMS = require('./timeSignals')
const CITY_TERMS = require('./cities.zh.json')
const PROVINCE_TERMS = require('./provinces.zh.json')
const COUNTRY_TERMS = require('./countries.zh.json')

/** 城市、省/地区与国家名合并（词典内仅中文别名，见各 *.zh.json）；供 queryLocationParser 识别地点并生成 location 筛选 */
const LOCATION_DICTIONARY = [...CITY_TERMS, ...PROVINCE_TERMS, ...COUNTRY_TERMS]

module.exports = {
  TIME_SIGNAL_TERMS,
  LOCATION_DICTIONARY
}
