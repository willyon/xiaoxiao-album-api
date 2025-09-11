/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 22:53:54
 * @Description: File description
 */
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const storageService = require("./storageService");
const imageModel = require("../models/imageModel");
const exifr = require("exifr");
const exiftool = require("exiftool-vendored").exiftool;
const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("../utils/logger");
const { stringToTimestamp } = require("../utils/formatTime");

// ========== 活跃的业务逻辑代码 ==========

// ========== URL处理工具函数 ==========

// 通用的URL添加方法
async function _addFullUrls(items, type = "image") {
  try {
    if (!items || !items.length) {
      return items;
    }

    // 根据类型选择处理逻辑
    if (type === "image") {
      // 处理图片：生成高清图片URL和缩略图URL
      for (const item of items) {
        if (item.highResStorageKey) {
          item.highResUrl = await storageService.getFileUrl(item.highResStorageKey, item.storageType);
          delete item.highResStorageKey; // 删除原始字段
        }
        if (item.thumbnailStorageKey) {
          item.thumbnailUrl = await storageService.getFileUrl(item.thumbnailStorageKey, item.storageType);
          delete item.thumbnailStorageKey; // 删除原始字段
        }
        // 删除 storageType 字段
        delete item.storageType;
      }
    } else if (type === "group") {
      // 处理分组：生成封面图片URL
      for (const item of items) {
        if (item.latestImagekey) {
          item.latestImageUrl = await storageService.getFileUrl(item.latestImagekey, item.storageType);
          delete item.latestImagekey; // 删除原始字段
        }
        // 删除 storageType 字段
        delete item.storageType;
      }
    }

    return items;
  } catch (error) {
    logger.error({
      message: `批量获取${type === "image" ? "图片" : "分组封面图片"}URL失败`,
      details: { error: error.message },
    });
  }
}

// 为图片数据添加完整URL的方法
async function _addFullUrlToImage(data) {
  return await _addFullUrls(data, "image");
}

// 为分组数据添加完整URL的方法
async function _addFullUrlToGroupCover(groups) {
  return await _addFullUrls(groups, "group");
}

// ========== 图片业务逻辑函数 ==========

/**
 * 图片元数据提取 - 兼容本地文件路径和Buffer
 * @param {string|Buffer} input - 文件路径（本地存储）或文件Buffer（OSS存储）
 * @returns {Promise<Object>} 标准化的元数据对象，包含以下字段：
 *   - captureTime: 拍摄时间戳 (如 1692087025000)
 *   - latitude: GPS纬度 (如 39.9042)
 *   - longitude: GPS经度 (如 116.4074)
 *   - altitude: GPS海拔 (如 43.5)
 * @throws {CustomError} 当EXIF读取失败时抛出错误
 */
async function extractImageMetadata(input) {
  try {
    let tempFilePath = null;

    // 统一处理输入，都转为 Buffer 给 exifr 使用
    let buffer = null;
    let filePath = null;

    if (Buffer.isBuffer(input)) {
      buffer = input;
    } else if (typeof input === "string") {
      buffer = fs.readFileSync(input);
      filePath = input; // 保存文件路径给 exiftool 使用
    } else {
      throw new Error("INPUT_NOT_SUPPORTED: input must be Buffer or file path string");
    }

    // 首先尝试使用 exifr 解析（性能更好）
    try {
      const data = await exifr.parse(buffer, {
        exif: true, // 拍摄参数：拍摄时间、ISO、光圈、焦距、快门速度、曝光模式等
        tiff: true, // 基础信息：图片尺寸、相机品牌型号、方向、颜色空间等
        gps: true, // GPS信息：纬度、经度、海拔、GPS时间戳等
        xmp: false, // Adobe扩展元数据：编辑历史、版权信息、关键词等（通常不需要）
        icc: false, // 颜色配置文件：颜色空间定义（文件较大，影响性能）
        iptc: false, // 新闻摄影元数据：标题、描述、关键词、作者等（通常不需要）
      });

      // exifr 成功解析，返回标准化结果
      if (data && Object.keys(data).length > 0) {
        logger.info({ message: "exifr 解析成功", details: { fieldsCount: Object.keys(data).length } });
        return _standardizeMetadata(data);
      }
    } catch (exifrError) {
      // exifr 解析失败，记录日志
      logger.warn({ message: "exifr 解析失败，尝试 exiftool", details: { error: exifrError.message } });
    }

    // exifr 失败时，使用 exiftool 作为备用方案（兼容性更好）
    try {
      let exiftoolData = null;

      if (filePath) {
        // 有文件路径，直接使用
        exiftoolData = await exiftool.read(filePath);
      } else {
        // 只有 Buffer，写入临时文件
        tempFilePath = path.join(os.tmpdir(), `temp_image_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.heic`);
        fs.writeFileSync(tempFilePath, buffer);
        exiftoolData = await exiftool.read(tempFilePath);
      }

      logger.info({ message: "exiftool 解析成功", details: { fieldsCount: Object.keys(exiftoolData).length } });
      return _standardizeMetadata(exiftoolData);
    } finally {
      // 清理临时文件
      if (tempFilePath) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          logger.warn({ message: "清理临时文件失败", details: { error: cleanupError.message } });
        }
      }
    }
  } catch (error) {
    logger.error({ message: "EXIF解析完全失败", details: { error: error.message } });
    throw new CustomError({
      httpStatus: 422, // Unprocessable Entity fits "bad file / unreadable EXIF"
      messageCode: ERROR_CODES.EXIF_READ_FAILED,
      messageType: "error",
    });
  }
}

/**
 * 标准化元数据格式
 * @param {Object} rawData - 原始元数据
 * @returns {Object} 标准化的元数据对象
 *
 * 两个库的字段差异：
 * - 经纬度: exifr提供latitude/longitude（数字），exiftool提供GPSLatitude/GPSLongitude（数字）
 * - 时间: exifr可能返回Date对象，exiftool返回字符串
 */
function _standardizeMetadata(rawData) {
  const result = {};

  // 拍摄时间
  if (rawData.DateTimeOriginal) {
    // 统一转换为时间戳
    if (rawData.DateTimeOriginal instanceof Date) {
      // exifr 返回 Date 对象，转换为时间戳
      result.captureTime = rawData.DateTimeOriginal.getTime();
    } else if (rawData.DateTimeOriginal.rawValue) {
      // exiftool 返回对象，使用 rawValue 字段
      result.captureTime = stringToTimestamp(rawData.DateTimeOriginal.rawValue);
    } else {
      // 兜底策略：尝试直接转换
      result.captureTime = stringToTimestamp(rawData.DateTimeOriginal);
    }
  }

  // GPS信息
  if (rawData.latitude !== undefined) {
    // exifr 成功时，直接提供 latitude 字段（数字类型）
    result.latitude = rawData.latitude;
  } else if (rawData.GPSLatitude !== undefined) {
    // exiftool 回退时，GPSLatitude 是数字类型
    result.latitude = rawData.GPSLatitude;
  }

  if (rawData.longitude !== undefined) {
    // exifr 成功时，直接提供 longitude 字段（数字类型）
    result.longitude = rawData.longitude;
  } else if (rawData.GPSLongitude !== undefined) {
    // exiftool 回退时，GPSLongitude 是数字类型
    result.longitude = rawData.GPSLongitude;
  }

  if (rawData.GPSAltitude !== undefined) {
    result.altitude = rawData.GPSAltitude;
  }

  return result;
}

// 保存新图片信息到数据库
async function saveNewImage(imageData) {
  // 参数校验
  const { userId, imageHash, thumbnailStorageKey } = imageData;
  if (!userId || !imageHash || !thumbnailStorageKey) {
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
    return result;
  } catch (error) {
    throw error;
  }
}

// 更新图片元数据和高质量图片
async function updateImageMetaAndHQ(imageData) {
  try {
    const result = await imageModel.updateMetaAndHQ(imageData);
    return result;
  } catch (error) {
    logger.error({
      message: "更新图片元数据失败",
      details: { imageData, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "更新图片元数据失败");
  }
}

// 获取用户图片哈希列表
async function getUserImageHashes(userId) {
  try {
    const hashes = await imageModel.selectHashesByUserId(userId);
    return hashes;
  } catch (error) {
    logger.error({
      message: "获取用户图片哈希失败",
      details: { userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片哈希失败");
  }
}

// ========== 图片查询服务函数 ==========

// 分页获取用户全部图片
async function getAllImagesByPage({ pageNo, pageSize, userId }) {
  try {
    const result = await imageModel.selectImagesByPage({
      pageNo,
      pageSize,
      userId,
    });

    // 添加完整URL
    result.data = await _addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户全部图片失败",
      details: { pageNo, pageSize, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某年份图片
async function getImagesByYear({ pageNo, pageSize, yearKey, userId }) {
  try {
    const result = await imageModel.selectImagesByYear({
      pageNo,
      pageSize,
      yearKey,
      userId,
    });

    // 添加完整URL
    result.data = await _addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某年份图片失败",
      details: { pageNo, pageSize, yearKey, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某月份图片
async function getImagesByMonth({ pageNo, pageSize, monthKey, userId }) {
  try {
    const result = await imageModel.selectImagesByMonth({ pageNo, pageSize, monthKey, userId });

    // 添加完整URL
    result.data = await _addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某月份图片失败",
      details: { pageNo, pageSize, monthKey, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 按年份获取分组信息
async function getGroupsByYear({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByYear({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_YEAR,
      messageType: "error",
    });
  }
}

// 按月份获取分组信息
async function getGroupsByMonth({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByMonth({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_MONTH,
      messageType: "error",
    });
  }
}

module.exports = {
  // ========== 图片业务逻辑函数 ==========
  extractImageMetadata,
  saveNewImage,
  updateImageMetaAndHQ,
  getUserImageHashes,

  // ========== 图片查询服务函数 ==========
  getAllImagesByPage,
  getImagesByYear,
  getImagesByMonth,
  getGroupsByYear,
  getGroupsByMonth,
};

// ========== 备用的注释代码（保留备用） ==========

// const fsExtra = require("fs-extra");
// const path = require("path");
// const imagemagick = require("imagemagick");
// const sharp = require("sharp");
// const crypto = require("crypto");
// const logger = require("../utils/logger");

// 判断文件是否为图片
// function isImage(file) {
//   return [".jpg", ".jpeg", ".png", ".avif", ".heic", ".heif", ".webp", ".gif"].includes(path.extname(file).toLowerCase());
// }

// 图片格式化
// function formatImage(convertParams) {
//   return new Promise((resolve, reject) => {
//     imagemagick.convert(convertParams, (error) => {
//       if (error) {
//         reject(error);
//       } else {
//         resolve();
//       }
//     });
//   });
// }

// ======= Sharp 编码器与克隆批量产物 =======

/**
 * 按输出扩展名选择编码器，并应用质量/效率参数
 */
// function _applyEncoderByExt(pipeline, ext, quality = 80) {
//   switch (ext) {
//     case "jpg":
//     case "jpeg":
//       return pipeline.jpeg({
//         quality, // 1–100，越高越清晰越大；一般 70–85 折中
//         mozjpeg: true, // 使用 mozjpeg 优化器，体积更小
//         chromaSubsampling: "4:2:0", // 色度抽样，压缩更好（人眼对色敏感度低于亮度）
//         trellisQuantisation: true, // 网格量化，进一步优化率失真
//         overshootDeringing: true, // 去振铃伪影，边缘更干净
//       });
//     case "png":
//       return pipeline.png({
//         compressionLevel: 6, // 0–9，越高越小但更慢
//         palette: true, // 尝试索引色调色板（适合扁平色/图标，能显著减小体积）
//       });
//     case "webp":
//       return pipeline.webp({
//         quality, // 有损质量；一般 35–60
//         smartSubsample: true, // 智能抽样，减少色彩伪影
//         effort: 3, // 0~6，越小越快；3 是很好的平衡点 effort表示编码器花多少 CPU 算力去挤压文件体积
//         nearLossless: false, // 是否启用"近无损"（为 true 时更接近 PNG 特性）
//       });
//     case "avif":
//       return pipeline.avif({
//         quality, // 一般 55–90；同等主观质量下比 WebP 文件更小
//         effort: Number(process.env.SHARP_AVIF_EFFORT || 3), // effort: 0–9，越大越慢、体积越小；5–7 是常见折中
//         chromaSubsampling: "4:2:0", // 色度抽样，减小体积
//       });
//     case "heic":
//     case "heif":
//       return pipeline.heif({
//         quality, // 1–100
//         compression: "hevc", // 编码器使用 HEVC
//         chromaSubsampling: "4:2:0",
//       });
//     default:
//       return pipeline.webp({
//         quality,
//         smartSubsample: true,
//         nearLossless: false,
//       });
//   }
// }

/**
 * 只解码一次原图，建立一条通用管线， 然后后续生成多个版本时用 .clone() 分支出去
 * @param {string|Buffer} input - 输入数据，可以是文件路径或Buffer
 */
// function _createSharpBase(input) {
//   return sharp(input, {
//     failOnError: false, // 避免遇到坏图直接崩
//     sequentialRead: true, // 顺序读取，减少磁盘随机 I/O
//     limitInputPixels: false, // 不限制像素避免超大图被强制拒绝（如需要可设上限）
//   }).rotate(); // 按 EXIF 自动旋转到正确方向
// }

/**
 * 批量场景 多产物批量转码：同一张图只解码一次，其余以 .clone() 并行编码
 * @param {Object} args
 * @param {string} args.inputPath
 * @param {Array<{
 *   outputPath: string,
 *   quality?: number,
 *   resizeWidth?: number,
 *   fit?: "cover"|"contain"|"inside"|"outside"|"fill",
 *   withoutEnlargement?: boolean
 * }>} args.tasks
 */
// async function formatMultipleImagesFromOneSource({ inputPath, tasks }) {
//   if (!tasks?.length) return { successPaths: [] };

//   await Promise.all(tasks.map((t) => fsExtra.ensureDir(path.dirname(t.outputPath))));

//   const base = _createSharpBase(inputPath);

//   const pipelines = tasks.map((t) => {
//     const ext = path.extname(t.outputPath).toLowerCase().slice(1);
//     let branch = base.clone();
//     if (t.resizeWidth) {
//       branch = branch.resize({
//         width: t.resizeWidth, //设定最大宽度
//         fit: "inside", // inside 保持原图比例，把图片缩小到不超过目标宽高的最大尺寸
//         withoutEnlargement: true, //如果原图本来就小于目标尺寸，不放大
//         fastShrinkOnLoad: true, //在解码图片的时候，如果目标尺寸（resizeWidth / resizeHeight）明显比原图小很多，Sharp 会直接在解码阶段先用更低分辨率读取，而不是先解出原图全尺寸再去缩小。
//         // kernel: sharp.kernel.lanczos2,
//       });
//     }
//     branch = _applyEncoderByExt(branch, ext, t.quality ?? 80);
//     return { branch, out: t.outputPath };
//   });

//   // 等"全部分支"结束
//   const settled = await Promise.allSettled(pipelines.map((p) => p.branch.toFile(p.out)));

//   const successPaths = [];
//   const errors = [];
//   settled.forEach((r, i) => {
//     if (r.status === "fulfilled") successPaths.push(pipelines[i].out);
//     else errors.push(r.reason || new Error("encode failed"));
//   });

//   if (errors.length) {
//     const err = new Error("BATCH_ENCODE_PARTIAL_FAILURE");
//     err.successPaths = successPaths; // 已经成功写到最终路径的文件
//     err.errors = errors; // 失败原因列表（可用于日志）
//     throw err;
//   }

//   return { successPaths };
// }
