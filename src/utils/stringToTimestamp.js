/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 15:07:02
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-30 15:09:06
 * @Description: File description
 */
const moment = require("moment");

function stringToTimestamp(str) {
  const date = moment(str, "YYYY:MM:DD HH:mm:ss"); // 指定日期格式
  return date.valueOf();
}

module.exports = {
  stringToTimestamp,
};
