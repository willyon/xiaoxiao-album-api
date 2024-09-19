/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-17 23:29:09
 * @Description: File description
 */
const fsExtra = require("fs-extra");
const path = require("path");
const { exiftool } = require("exiftool-vendored");
const imagemagick = require("imagemagick");
// 有弃用模块问题
// const imageHash = require("image-hash");
//不支持heic格式
// const sharp = require("sharp");
const crypto = require("crypto");

// 判断文件是否为图片
function isImage(file) {
  return [".jpg", ".jpeg", ".png", ".avif", ".heic", ".heif", ".webp", ".gif"].includes(path.extname(file).toLowerCase());
}

// 判断图片是否重复
async function isDuplicate(imagePath, existingImages) {
  const currentHash = await calculateImageHash(imagePath);
  return !!existingImages.find((image) => image.hash === currentHash);
}

// 图片格式化
function formatImage(convertParams) {
  return new Promise((resolve, reject) => {
    imagemagick.convert(convertParams, (error) => {
      if (error) {
        reject("格式化图片失败");
      } else {
        resolve();
      }
    });
  });
}

// 回退操作：图片处理过程中出错时，删除出错步骤对应的可能已处理成功的图片
function rollbackOperation(filePath) {
  if (fsExtra.existsSync(filePath)) {
    fsExtra.unlinkSync(filePath);
  }
}

// 图片元数据提取
async function extractImageMetadata(filePath) {
  try {
    const exifData = await exiftool.read(filePath);
    return exifData;
  } catch (err) {
    console.log(`获取图片${path.basename(filePath)}元数据失败：${err}`);
    throw err;
  }
}

// 计算图片哈希值
async function calculateImageHash(imagePath) {
  return new Promise((resolve, reject) => {
    // imageHash(imagePath, 16, true, (error, data) => {
    //   if (error) {
    //     reject(error);
    //   } else {
    //     resolve(data); // 返回图片的哈希值
    //   }
    // });
    const hash = crypto.createHash("md5");
    const stream = fsExtra.createReadStream(imagePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function generateImageHash(imagePath) {}

module.exports = {
  isImage,
  isDuplicate,
  formatImage,
  rollbackOperation,
  calculateImageHash,
  extractImageMetadata,
};
