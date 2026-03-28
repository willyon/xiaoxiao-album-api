/*
 * @Description: 中文场景搜索语义词典统一导出（时间与城市结构化解析）
 */

const TIME_SIGNAL_TERMS = require("./timeSignals");
/** 全国市名；请直接维护此文件 */
const CITY_DICTIONARY = require("./cities.js");

module.exports = {
  TIME_SIGNAL_TERMS,
  CITY_DICTIONARY,
};
