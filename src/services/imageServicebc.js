/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:39
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-05 17:13:57
 * @Description: 图片格式转换、图片压缩等相关操作
 */

const imagemagick = require("imagemagick");

async function imageFormatter(params) {
  const { inputPath, outputPathBig, outputPathSmall } = params;
  await Promise.all([
    new Promise((resolve, reject) => {
      imagemagick.convert([inputPath, "-quality", "60", outputPathBig], (err) => (err ? reject(err) : resolve()));
    }),
    new Promise((resolve, reject) => {
      imagemagick.convert([inputPath, "-quality", "50", "-resize", "800x", outputPathSmall], (err) => (err ? reject(err) : resolve()));
    }),
  ]);
}

module.exports = { imageFormatter };
