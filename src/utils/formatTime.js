/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 15:07:02
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 22:25:34
 * @Description: File description
 */
const { DateTime } = require("luxon");

// 定义两种格式
const WITH_ZONETIME = "yyyy:MM:dd HH:mm:ssZZ"; // 包含时区信息
const NO_ZONETIME = "yyyy:MM:dd HH:mm:ss"; // 不包含时区信息

/**
 * 将时间字符串转换为时间戳（毫秒）
 * 支持带时区和不带时区两种格式的时间字符串
 *
 * 时区处理说明：
 * - 带时区的EXIF时间：按实际时区解析，显示时可能与拍摄地时间不一致
 * - 不带时区的EXIF时间：按服务器时区解释，显示时间与拍摄时间保持一致
 *
 * @param {string} timeStr - 时间字符串
 *   - 带时区格式：'yyyy:MM:dd HH:mm:ssZZ' 如 '2024:08:15 14:30:25+08:00'（直接解析时区信息）
 *   - 不带时区格式：'yyyy:MM:dd HH:mm:ss' 如 '2024:08:15 14:30:25'（按系统默认时区解释）
 * @returns {number|null} UTC时间戳（毫秒），解析失败时返回 null
 *
 * @example
 * stringToTimestamp('2024:08:15 14:30:25+08:00'); // 带时区，按UTC解析
 * stringToTimestamp('2024:08:15 14:30:25');       // 不带时区，按服务器时区解析
 * stringToTimestamp('');                          // 返回 null
 *
 * 带时区信息的字符串 最后算出来的是 UTC 绝对时间
 * 因为目前后端处理时间使用的是系统默认时区(服务器所在地时区) 所以如果拍摄地与服务器部署地有时差的话 且图片元数据带有时区信息
 * 那最终网页展示的时间与图片拍摄时间就会不一致
 * 同理 如果不带时区信息的字符串 最后算出来的是系统默认时区时间 那么最终展示的时间与拍摄时间就是一致的
 * 比如一个英国用户在2024:08:15 14:30:25拍摄了一张图片并上传网站
 * 那么位于中国的服务器在处理这张图片时 就是按照中国时区时间去处理 也就是默认这张图片拍摄于时间北京时间2024:08:15 14:30:25
 */
function stringToTimestamp(timeStr) {
  if (!timeStr) {
    return null;
  }

  // 根据是否包含时区信息选择解析方式
  const dateTime =
    timeStr.includes("+") || timeStr.includes("-") ? DateTime.fromFormat(timeStr, WITH_ZONETIME) : DateTime.fromFormat(timeStr, NO_ZONETIME);

  // 检查解析结果
  if (!dateTime.isValid) {
    // 时间格式化出错，使用当前时间作为fallback
    console.error("时间格式化出错:", dateTime.invalidReason);
    return null;
  }

  // 返回时间戳（毫秒）
  return dateTime.toMillis();
}

/**
 * 将时间戳转换为年月格式字符串（YYYY-MM格式）
 * @param {number|null} timestamp - 时间戳（毫秒）
 * @returns {string} 年月字符串，如 "2024-08" 或 "unknown"
 */
function timestampToYearMonth(timestamp) {
  if (timestamp == null) return "unknown"; // timestamp为null或undefined
  const dt = DateTime.fromMillis(Number(timestamp)); // 使用系统默认时区，与stringToTimestamp保持一致
  return dt.isValid ? dt.toFormat("yyyy-MM") : "unknown";
}

/**
 * 将时间戳转换为年份格式字符串（YYYY格式）
 * @param {number|null} timestamp - 时间戳（毫秒）
 * @returns {string} 年份字符串，如 "2024" 或 "unknown"
 */
function timestampToYear(timestamp) {
  if (timestamp == null) return "unknown";
  const dt = DateTime.fromMillis(Number(timestamp)); // 使用系统默认时区，与stringToTimestamp保持一致
  return dt.isValid ? dt.toFormat("yyyy") : "unknown";
}

module.exports = {
  stringToTimestamp,
  timestampToYearMonth,
  timestampToYear,
};
