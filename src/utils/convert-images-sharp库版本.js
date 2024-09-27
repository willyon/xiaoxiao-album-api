/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-29 23:45:51
 * @Description: File description
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

// 配置文件夹路径
const sourceFolder = path.join(__dirname, "..", "..", process.env.ORIGINAL_IMAGES_DIR);
const archiveFolder = path.join(__dirname, "..", "..", process.env.ORIGINAL_IMAGES_ARCHIVE_DIR);
const bigHighImageFolder = path.join(__dirname, "..", "..", process.env.BIG_IMAGES_DIR);
const smallImageFolder = path.join(__dirname, "..", "..", process.env.SMALL_IMAGES_DIR);
const logFile = path.join(__dirname, "..", "..", process.env.CONVERSION_LOG_FILE);

// 确保目标文件夹存在
if (!fs.existsSync(bigHighImageFolder)) {
  fs.mkdirSync(bigHighImageFolder);
}
if (!fs.existsSync(smallImageFolder)) {
  fs.mkdirSync(smallImageFolder);
}
if (!fs.existsSync(archiveFolder)) {
  fs.mkdirSync(archiveFolder);
}

// 创建日志流
const logStream = fs.createWriteStream(logFile, { flags: "a" });

function logError(message) {
  console.error(message);
  logStream.write(message + "\n");
}

function convertImage(file) {
  console.log("文件:", file);
  // 只处理图片文件
  if (
    //  sharp库使用有问题 解决了半天没搞成 暂不支持".heic" 其它没问题 已测试
    [".jpg", ".jpeg", ".png", ".avif", ".webp", ".gif"].includes(path.extname(file).toLowerCase())
  ) {
    const filePath = path.join(sourceFolder, file);
    const bigHighFilePath = path.join(bigHighImageFolder, path.parse(file).name + ".avif");
    console.log("大图路径:", bigHighFilePath);
    const smallFilePath = path.join(smallImageFolder, path.parse(file).name + "_small.avif");
    console.log("小图路径:", smallFilePath);
    const archiveFilePath = path.join(archiveFolder, file);
    console.log("存档路径:", archiveFilePath);
    console.log("filePath:", filePath);

    const image = sharp(filePath);

    // 转换为 AVIF 和缩小图像
    Promise.all([
      image.clone().toFormat("avif", { quality: 60 }).toFile(bigHighFilePath),
      image.clone().resize(800).toFormat("avif", { quality: 80 }).toFile(smallFilePath),
    ])
      .then(() => {
        console.log(`成功将图片文件 ${file} 转为avif格式及其缩略图`);

        // 移动源文件到存档文件夹
        fs.rename(filePath, archiveFilePath, (err) => {
          if (err) {
            logError(`移动图片源文件 ${file} 到存档文件夹失败: ${err.message}`);
          } else {
            console.log(`移动图片源文件 ${file} 到存档文件夹完毕`);
          }
        });
      })
      .catch((err) => {
        logError(`图片文件 ${file} 格式转换失败: ${err.message}`);
        // 回退操作：删除已转换的文件
        fs.unlink(bigHighFilePath, (unlinkErr) => {
          if (unlinkErr) {
            logError(`删除avif文件 ${bigHighFilePath} 失败: ${unlinkErr.message}`);
          }
        });
        fs.unlink(smallFilePath, (unlinkErr) => {
          if (unlinkErr) {
            logError(`删除avif缩略图文件 ${smallFilePath} 失败: ${unlinkErr.message}`);
          }
        });
      });
  }
}

// 读取文件夹中的所有图片文件
fs.readdir(sourceFolder, (err, files) => {
  if (err) {
    logError(`读取图片源文件目录失败：${err.message}`);
    return;
  }

  files.forEach(convertImage);
});
