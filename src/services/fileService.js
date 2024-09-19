/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:47
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-17 07:59:19
 * @Description: 读取图片信息，如exif数据、创建时间、文件大小等
 */

const fsPromise = require("fs/promises");
const fsExtra = require("fs-extra");

// 文件读取
async function readFile(folder) {
  try {
    let files = await fsPromise.readdir(folder);
    return files;
  } catch (error) {
    console.log("读取文件失败：", error);
  }
}

// 文件移动
// fsExtra.move(filePath, archiveSucceededFilePath);

module.exports = {
  readFile,
};
