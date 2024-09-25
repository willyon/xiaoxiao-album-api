/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 15:07:02
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-25 15:28:56
 * @Description: File description
 */
const { DateTime } = require("luxon");

function stringToTimestamp(str) {
  const date = DateTime.fromFormat(str, "yyyy:MM:dd HH:mm:ss");
  // 检查是否解析成功
  if (!date.isValid) {
    console.error("时间格式化出错:", date.invalidReason);
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
