/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 22:24:29
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-17 23:53:13
 * @Description: File description
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { db } = require("../src/services/dbService");
const { isImage } = require("../src/services/imageService");

// 删除图片转换过程中涉及的所有目标文件夹的所有图片
function deleteFolderSync(folderPath) {
  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach((file) => {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderSync(curPath); // 递归删除子文件夹
      } else {
        fs.unlinkSync(curPath); // 删除文件
      }
    });
    // fs.rmdirSync(folderPath); // 删除空文件夹
  }
}
const bigImageFolder = path.join(__dirname, "..", process.env.PROCESSED_BIG_IMAGE_DIR);
const smallImageFolder = path.join(__dirname, "..", process.env.PROCESSED_SMALL_IMAGE_DIR);
const duplicateFolder = path.join(__dirname, "..", process.env.DUPLICATE_IMAGE_DIR);
const originalFolder = path.join(__dirname, "..", process.env.PROCESSED_ORIGINAL_IMAGE_DIR);
deleteFolderSync(bigImageFolder);
deleteFolderSync(smallImageFolder);
deleteFolderSync(duplicateFolder);
deleteFolderSync(originalFolder);

// 清空数据表内容
function resetTable() {
  // 开始事务
  const transaction = db.transaction(() => {
    try {
      // 删除所有数据
      db.prepare("DELETE FROM images").run();

      // 重置自增 ID
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'images'").run();

      console.log("images数据表已清空，ID已重置");
    } catch (error) {
      console.error("images表重置出错:", error);
    }
  });
  // 执行事务
  transaction();
  // 可选：进行 VACUUM 操作来整理数据库 vacuum需要放在事务之外执行
  db.prepare("VACUUM").run();
}
// 执行重置操作
resetTable();
// 关闭数据库连接
db.close();

// 给uploadedFiles文件夹添加测试图片
// 源文件夹路径
const sourceFolder = path.join(__dirname, "..", "uploadedFilesTest");
console.log("sourceFolder:", sourceFolder);

// 目标文件夹路径
const destinationFolder = path.join(__dirname, "..", process.env.UPLOADS_DIR);
console.log("destinationFolder:", destinationFolder);

// 确保目标文件夹存在
if (!fs.existsSync(destinationFolder)) {
  fs.mkdirSync(destinationFolder, { recursive: true });
}

// 复制文件的函数
function copyFiles(sourceDir, destDir, numFiles) {
  // 读取源文件夹中的文件
  const files = fs.readdirSync(sourceDir);

  // 只选择前 numFiles 个文件
  let filesToCopy = files.slice(0, numFiles);
  filesToCopy = filesToCopy.filter(isImage);

  filesToCopy.forEach((file) => {
    const srcPath = path.join(sourceDir, file);
    const destPath = path.join(destDir, file);

    // 复制文件
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied ${file} to ${destDir}`);
  });
}

// 执行文件复制
copyFiles(sourceFolder, destinationFolder, 20);
