/*
 * @Author: zhangshouchang
 * @Date: 2024-08-27 17:14:48
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-29 01:38:24
 * @Description: File description
 */
require("dotenv").config();
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");
const exifParser = require("exif-parser");
const { exiftool } = require("exiftool-vendored");

// 指定要处理的图片文件夹路径
const imageDirectory = path.join(
  __dirname,
  "..",
  "..",
  process.env.ORIGINAL_IMAGES_DIR
);

function isJpeg(filePath) {
  return [".jpg", ".jpeg"].includes(path.extname(filePath).toLowerCase());
}

function getImgDataBySharp(filePath) {
  sharp(filePath)
    .metadata()
    .then((metadata) => {
      console.log(`文件：${file}`);
      console.log("元数据：", metadata);
      if (metadata.exif) {
        const exifBuffer = metadata.exif;
        const parser = exifParser.create(exifBuffer);
        const exifDataTags = parser.parse().tags;
        console.log("exifDataTags:", exifDataTags);

        // 获取拍摄时间
        const creationDate = exifDataTags.DateTimeOriginal;
        console.log("拍摄时间：", creationDate);

        // 拍摄地点(如果存在GPS数据）
        if (exifDataTags.GPSLatitude && exifDataTags.GPSLongitude) {
          const latitude = exifDataTags.GPSLatitude;
          const longitude = exifDataTags.GPSLongitude;
          console.log("拍摄地点：纬度 ", latitude, "经度 ", longitude);
        } else {
          console.log("没有GPS数据");
        }
      } else {
        console.log("没有找到EXIF数据");
      }
    })
    .catch((err) => {
      console.log(`处理文件 ${file} 时出错：`, err);
    });
}

function getImgDataByExiftool(filePath) {
  exiftool
    .read(filePath)
    .then((tags) => {
      console.log("EXIF data:", tags.CreateDate, tags.DateTimeOriginal, 999);
    })
    .catch((err) => {
      console.error("Error reading EXIF data:", err.message);
    });
}

//读取文件夹中的所有文件
fs.readdir(imageDirectory, (err, files) => {
  if (err) {
    console.log("无法读取目录", err);
    return;
  }

  files.forEach((file) => {
    const filePath = path.join(imageDirectory, file);
    // if (isJpeg(filePath)) {
    getImgDataByExiftool(filePath);
    // getImgDataBySharp(filePath)
    // }
  });
});
