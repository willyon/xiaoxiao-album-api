/*
 * @Description: 中文场景搜索语义词典统一导出
 */

const SUBJECT_DICTIONARY = require("./subjects");
const ACTION_DICTIONARY = require("./actions");
const SCENE_DICTIONARY = require("./scenes");
const TIME_SIGNAL_TERMS = require("./timeSignals");
/** 全国市名：仅 cities.js（结构同 scenes.js）；请直接维护此文件 */
const CITY_DICTIONARY = require("./cities.js");

module.exports = {
  SUBJECT_DICTIONARY,
  ACTION_DICTIONARY,
  SCENE_DICTIONARY,
  TIME_SIGNAL_TERMS,
  CITY_DICTIONARY,
};
