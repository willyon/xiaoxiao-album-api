/*
 * @Description: 中文场景搜索语义词典统一导出（时间与地点结构化解析）
 */

const TIME_SIGNAL_TERMS = require('./timeSignals')
const CITY_TERMS = require('./cities.js')
const PROVINCE_TERMS = require('./provinces.js')
const COUNTRY_TERMS = require('./countries.js')

/** 城市、省/地区、港澳与国家名合并；供 queryLocationParser 识别自然语言中的地点并生成 location 筛选 */
const LOCATION_DICTIONARY = [...CITY_TERMS, ...PROVINCE_TERMS, ...COUNTRY_TERMS]

module.exports = {
  TIME_SIGNAL_TERMS,
  LOCATION_DICTIONARY
}
