/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:47
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-09 22:09:21
 * @Description: 读取图片信息，如exif数据、创建时间、文件大小等
 */

const fsPromise = require("fs/promises");
const { ERROR_CODES } = require("../constants/messageCodes");
const CustomError = require("../errors/customError");
// const fsExtra = require("fs-extra");

// 文件读取
async function readFile(folder) {
  try {
    let files = await fsPromise.readdir(folder);
    return files;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_TO_READ_FILE,
      messageType: "error",
    });
  }
}

// 文件移动
// fsExtra.move(filePath, archiveSucceededFilePath);

module.exports = {
  readFile,
};
