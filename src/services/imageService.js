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
const { getStandardMimeType } = require("../utils/fileUtils");
const sharp = require("sharp");
const { randomUUID } = require("crypto");

// EXIF Orientation 字符串 → 数值映射（exiftool 常见输出）
const ORIENTATION_MAP = {
  "Horizontal (normal)": 1,
  "Mirror horizontal": 2,
  "Rotate 180": 3,
  "Mirror vertical": 4,
  "Mirror horizontal and rotate 270 CW": 5,
  "Rotate 90 CW": 6,
  "Mirror horizontal and rotate 90 CW": 7,
  "Rotate 270 CW": 8,
};

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
// 注意：isFavorite 字段现在直接从数据库查询返回，无需额外处理
async function addFullUrlToImage(data) {
  return await _addFullUrls(data, "image");
}

// 为分组数据添加完整URL的方法
async function _addFullUrlToGroupCover(groups) {
  return await _addFullUrls(groups, "group");
}

// ========== 图片业务逻辑函数 ==========

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

// 保存已处理的图片元数据（包含错误处理和日志记录）
async function saveProcessedImageMetadata(imageData) {
  try {
    const result = await imageModel.updateImageMetadata(imageData);
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

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

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
// albumId: 对于时间相册，实际上是 year_key (如 "2024")
async function getImagesByYear({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await imageModel.selectImagesByYear({
      pageNo,
      pageSize,
      albumId,
      userId,
    });

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某年份图片失败",
      details: { pageNo, pageSize, albumId, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某月份图片
// albumId: 对于时间相册，实际上是 month_key (如 "2024-01")
async function getImagesByMonth({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await imageModel.selectImagesByMonth({ pageNo, pageSize, albumId, userId });

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某月份图片失败",
      details: { pageNo, pageSize, albumId, userId, error: error.message },
    });
    throw new CustomError(ERROR_CODES.INTERNAL_SERVER_ERROR, "获取用户图片失败");
  }
}

// 分页获取用户某日期图片
// albumId: 对于时间相册，实际上是 date_key (如 "2024-01-15")
async function getImagesByDate({ pageNo, pageSize, albumId, userId }) {
  try {
    const result = await imageModel.selectImagesByDate({ pageNo, pageSize, albumId, userId });

    // 添加完整URL（isFavorite字段已从数据库直接返回）
    result.data = await addFullUrlToImage(result.data);

    return result;
  } catch (error) {
    logger.error({
      message: "分页获取用户某日期图片失败",
      details: { pageNo, pageSize, albumId, userId, error: error.message },
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

// 按日期获取分组信息
async function getGroupsByDate({ userId, pageNo = 1, pageSize = 10, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectGroupsByDate({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = await _addFullUrlToGroupCover(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_GROUPS_BY_DATE,
      messageType: "error",
    });
  }
}

module.exports = {
  // ========== 图片业务逻辑函数 ==========
  saveNewImage,
  saveProcessedImageMetadata,
  getUserImageHashes,

  // ========== 图片查询服务函数 ==========
  getAllImagesByPage,
  getImagesByYear,
  getImagesByMonth,
  getImagesByDate,
  getGroupsByYear,
  getGroupsByMonth,
  getGroupsByDate,
  addFullUrlToImage,
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
