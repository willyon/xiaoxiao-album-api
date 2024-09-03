/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-31 00:31:03
 * @Description: File description
 */
require("dotenv").config();
const fsExtra = require("fs-extra");
const fsPromise = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { exiftool } = require("exiftool-vendored");
const { isImage } = require("./isImage");
const { stringToTimestamp } = require("./stringToTimestamp");
const IMG_EXTENSION = process.env.CONVERT_IMAGE_EXTENSION;

// 转换大图目录
const bigImageFolder = path.join(__dirname, "..", "..", process.env.BIG_IMAGES_DIR);
// 转换小图目录
const smallImageFolder = path.join(__dirname, "..", "..", process.env.SMALL_IMAGES_DIR);
// 日志文件目录
const logFile = path.join(__dirname, "..", "..", process.env.CONVERSION_LOG_FILE);

// 确保目标文件夹存在 若不存在 会自动创建
fsExtra.ensureDirSync(bigImageFolder);
fsExtra.ensureDirSync(smallImageFolder);

// 创建日志流 a表示 新内容是在原来内容基础新增 而不是覆盖
const logStream = fs.createWriteStream(logFile, { flags: "a" });

// 元数据提取有值数量统计
let succeededCount = 0;
let failedCount = 0;
let imageMessageArr = [];

const logError = (message) => {
  console.error(message);
  logStream.write(message + "\n");
};

// 读取成功格式化大图文件夹中的所有图片文件
const getImageMetadata = () => {
  return fsPromise
    .readdir(bigImageFolder)
    .then((files) => {
      return Promise.allSettled(files.map(getPictureMetadata));
    })
    .then((res) => {
      console.log("有元数据图片数量：", succeededCount);
      console.log("无元数据图片数量：", failedCount);
      return imageMessageArr;
      // 后续操作
    })
    .catch((err) => {
      logError(`执行出错：${err.message}`);
    });
};

const getPictureMetadata = (file) => {
  if (isImage(file)) {
    const filePath = path.join(bigImageFolder, file);
    const baseName = path.parse(file).name;
    return exiftool
      .read(filePath)
      .then((tags) => {
        //  tags.DateTimeOriginal
        tags.CreateDate ? succeededCount++ : failedCount++;
        imageMessageArr.push({
          bigPath: path.join(`/${process.env.BIG_IMAGES_DIR}`, file),
          smallPath: path.join(`/${process.env.SMALL_IMAGES_DIR}`, file),
          creationDate: tags.CreateDate ? stringToTimestamp(tags.CreateDate.rawValue) : "",
        });
        // 移动该文件到数据提取成功图片存档文件夹
        // fsExtra.move(filePath, archiveSucceededFilePath);
      })
      .catch((err) => {
        console.error("获取大图数据失败:", err.message);
      });
  }
};

module.exports = {
  getImageMetadata,
};
