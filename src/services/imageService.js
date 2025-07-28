/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-06 16:22:41
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
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");

const imageModel = require("../models/imageModel");

// 判断文件是否为图片
function isImage(file) {
  return [".jpg", ".jpeg", ".png", ".avif", ".heic", ".heif", ".webp", ".gif"].includes(path.extname(file).toLowerCase());
}

// 判断图片是否重复
async function isDuplicate(currentHash, existingImages) {
  return !!existingImages.find((image) => image.hash === currentHash);
}

// 图片格式化
function formatImage(convertParams) {
  return new Promise((resolve, reject) => {
    imagemagick.convert(convertParams, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// 回退操作：图片处理过程中出错时，删除出错步骤对应的可能已处理成功的图片
function rollbackOperation(filePath) {
  return fsExtra
    .pathExists(filePath) // 返回 Promise
    .then((exists) => {
      if (exists) {
        return fsExtra.unlink(filePath); // 返回异步 unlink 的 Promise
      } else {
        // console.log("The file or directory does not exist.");
      }
    })
    .catch((error) => {
      throw error;
    });
}

// 图片元数据提取
async function extractImageMetadata(filePath) {
  try {
    return await exiftool.read(filePath);
  } catch (error) {
    throw error;
  }
}

// 计算图片哈希值
async function calculateImageHash(imagePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fsExtra.createReadStream(imagePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// async function generateImageHash(imagePath) {}

async function getAllImages() {
  try {
    return await imageModel.selectAllImages();
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_ALL_DATA,
      messageType: "error",
    });
  }
}

async function getAllImagesByPage({ pageNo = 1, pageSize = 10 }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    return await imageModel.selectImagesByPage({ pageNo, pageSize });
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_BY_PAGE,
      messageType: "error",
    });
  }
}

async function getImagesByTimeRange({ pageNo = 1, pageSize = 10, creationDate = null, timeRange = "" }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    return await imageModel.selectImagesByTimeRange({ pageNo, pageSize, creationDate, timeRange });
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_BY_TIME_RANGE,
      messageType: "error",
    });
  }
}

async function getGroupsByYear({ pageNo = 1, pageSize = 10 }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    return await imageModel.selectGroupsByYear({ pageNo, pageSize });
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: "error",
    });
  }
}

async function getGroupsByMonth({ pageNo = 1, pageSize = 10 }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    return await imageModel.selectGroupsByMonth({ pageNo, pageSize });
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_MONTH,
      messageType: "error",
    });
  }
}

async function setUpTableImages() {
  try {
    await imageModel.createTableImages();
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.TABLE_CREATE_FAILED,
      messageType: "error",
    });
  }
}

async function saveNewImage(imageData) {
  // 参数校验
  const { originalImageUrl, bigHighQualityImageUrl, bigLowQualityImageUrl, previewImageUrl, hash } = imageData;
  if (!originalImageUrl || !bigHighQualityImageUrl || !bigLowQualityImageUrl || !previewImageUrl || !hash) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const result = await imageModel.insertImage(imageData);
    if (result.affectedRows === 0) {
      throw new CustomError({
        httpStatus: 500,
        messageCode: ERROR_CODES.DATA_INSERT_FAILED,
        messageType: "error",
      });
    }
    console.log("Image insert successful:");
    return result;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.DATA_INSERT_FAILED,
      messageType: "error",
    });
  }
}

module.exports = {
  isImage,
  isDuplicate,
  formatImage,
  rollbackOperation,
  calculateImageHash,
  extractImageMetadata,
  getAllImagesByPage,
  getImagesByTimeRange,
  getAllImages,
  getGroupsByYear,
  getGroupsByMonth,
  setUpTableImages,
  saveNewImage,
};
