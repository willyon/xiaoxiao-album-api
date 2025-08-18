/*
 * @Author: zhangshouchang
 * @Date: 2025-08-18 09:58:48
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-18 09:58:58
 * @Description: File description
 */
const sharp = require("sharp");
if (!sharp.format.heif?.input?.file) {
  console.error("⚠️  当前环境 sharp 不支持 HEIC，请检查 libvips/libheif。");
  process.exit(1);
} else {
  console.log("✅ HEIC 支持正常：", sharp.versions);
}
