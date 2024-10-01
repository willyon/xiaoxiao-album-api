/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 15:07:02
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-30 16:43:49
 * @Description: File description
 */
const { DateTime } = require("luxon");

// 定义两种格式
const formatWithZone = "yyyy:MM:dd HH:mm:ssZZ"; // 包含时区信息
const formatWithoutZone = "yyyy:MM:dd HH:mm:ss"; // 不包含时区信息

function stringToTimestamp(timeStr) {
  if (!timeStr) {
    return null;
  } else if (timeStr.includes("+") || timeStr.includes("-")) {
    var date = DateTime.fromFormat(timeStr, formatWithZone);
  } else {
    var date = DateTime.fromFormat(timeStr, formatWithoutZone);
  }
  // 检查是否解析成功
  if (!date.isValid) {
    console.error("时间格式化出错:", date.invalidReason);
    return null;
  } else {
    // 获取时间戳（毫秒）
    return date.toMillis();
  }
}

function getStartOrEndOfTime(timestamp, type, rangeType) {
  // 转为Datetime对象
  const date = DateTime.fromMillis(+timestamp);
  // 格式化输出
  const dateResult = date[`${type}Of`](rangeType);
  return dateResult.toMillis();
}

module.exports = {
  stringToTimestamp,
  getStartOrEndOfTime,
};
