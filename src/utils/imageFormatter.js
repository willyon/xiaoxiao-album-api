/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-01 02:18:05
 * @Description: File description
 */
require("dotenv").config();
const fsExtra = require("fs-extra");
const fsPromise = require("fs/promises");
const fs = require("fs");
const path = require("path");
const im = require("imagemagick");
const { isImage } = require("./isImage");
const IMG_EXTENSION = process.env.CONVERT_IMAGE_EXTENSION;

// 源文件目录
const sourceFolder = path.join(__dirname, "..", "..", process.env.UPLOADS_DIR);
// 转换成功源图片存档目录
const succeededArchive = path.join(__dirname, "..", "..", process.env.CONVERT_IMAGES_SUCCEEDED_DIR);
// 转换失败源图片存档目录
const failedArchive = path.join(__dirname, "..", "..", process.env.CONVERT_IMAGES_FAILED_DIR);
// 转换大图目录
const bigHighImageFolder = path.join(__dirname, "..", "..", process.env.BIG_IMAGES_DIR);
// 转换小图目录
const smallImageFolder = path.join(__dirname, "..", "..", process.env.SMALL_IMAGES_DIR);
// 日志文件目录
const logFile = path.join(__dirname, "..", "..", process.env.CONVERSION_LOG_FILE);

// 确保目标文件夹存在 若不存在 会自动创建
fsExtra.ensureDirSync(succeededArchive);
fsExtra.ensureDirSync(failedArchive);
fsExtra.ensureDirSync(bigHighImageFolder);
fsExtra.ensureDirSync(smallImageFolder);

// 创建日志流 a表示 新内容是在原来内容基础新增 而不是覆盖
const logStream = fs.createWriteStream(logFile, { flags: "a" });

// 格式化文件结果数量统计
let succeededCount = 0;
let failedCount = 0;

// 读取文件夹中的所有图片文件
const imageFormat = () => {
  return fsPromise
    .readdir(sourceFolder)
    .then((files) => {
      console.log("成功读取源文件：", files);
      // 处理读取到的文件列表 开始格式化
      return Promise.allSettled(files.map(startFormatting));
    })
    .then((res) => {
      console.log("格式化成功数量：", succeededCount);
      console.log("格式化失败数量：", failedCount);
      // 后续操作 如提取格式化后的图片元数据
    })
    .catch((err) => {
      logError(`执行出错：${err.message}`);
    });
};

const logError = (message) => {
  console.error(message);
  logStream.write(message + "\n");
};

const startFormatting = (file) => {
  // 只处理图片文件
  if (isImage(file)) {
    //  原文件路径
    const filePath = path.join(sourceFolder, file);
    // 文件名
    const baseName = path.parse(file).name;
    //  大图路径
    const bigFile = path.join(bigHighImageFolder, `${baseName}.${IMG_EXTENSION}`);
    // 小图路径
    const smallFile = path.join(smallImageFolder, `${baseName}.${IMG_EXTENSION}`);
    // 格式化成功原图存档路径
    const archiveSucceededFilePath = path.join(succeededArchive, file);
    // 格式化失败原图存档路径
    const archiveFailedFilePath = path.join(failedArchive, file);

    return Promise.all([
      new Promise((resolve, reject) => {
        im.convert([filePath, "-quality", "60", bigFile], (err) => (err ? reject(err) : resolve()));
      }),
      new Promise((resolve, reject) => {
        im.convert([filePath, "-quality", "50", "-resize", "800x", smallFile], (err) => (err ? reject(err) : resolve()));
      }),
    ])
      .then(() => {
        succeededCount++;
        // 移动源文件到转换成功图片存档文件夹
        // fsExtra.move(filePath, archiveSucceededFilePath);
      })
      .catch((err) => {
        failedCount++;
        logError(`图片文件 ${file} 格式转换失败: ${err}`);
        // 移动源文件到转换失败图片存档文件夹 暂时注释 方便测试
        // fsExtra.move(filePath, archiveFailedFilePath);
        // 回退操作：删除已转换的文件
        if (fsExtra.existsSync(bigFile)) {
          fsExtra.unlinkSync(bigFile);
        }
        if (fsExtra.existsSync(smallFile)) {
          fsExtra.unlinkSync(smallFile);
        }
      });
  }
};

module.exports = {
  imageFormat,
};
