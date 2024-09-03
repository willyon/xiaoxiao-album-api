/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 12:29:23
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-30 13:20:20
 * @Description: File description
 */
const path = require("path");
function isImage(file) {
  return [".jpg", ".jpeg", ".png", ".avif", ".heic", ".heif", ".webp", ".gif"].includes(path.extname(file).toLowerCase());
}

module.exports = {
  isImage,
};
