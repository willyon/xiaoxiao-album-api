/*
 * @Author: zhangshouchang
 * @Date: 2024-08-29 02:08:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 22:53:54
 * @Description: File description
 */
const fsExtra = require("fs-extra");
const path = require("path");
const { exiftool } = require("exiftool-vendored");
const imagemagick = require("imagemagick");
const sharp = require("sharp");
// const crypto = require("crypto");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const logger = require("../utils/logger");

const imageModel = require("../models/imageModel");
const StorageService = require("./StorageService");

// 创建存储服务实例
const storageService = new StorageService();

// 为图片添加完整URL的工具函数
function _addFullUrlsToImages(images) {
  return images.map((image) => ({
    ...image,
    highResUrl: storageService.getFileUrl(image.highResUrl),
    thumbnailUrl: storageService.getFileUrl(image.thumbnailUrl),
  }));
}

// 为按年/按月份组数据封面图片添加完整URL的工具函数
function _addFullUrlsToGroupCover(groups) {
  return groups.map((group) => ({
    ...group,
    latestImageUrl: storageService.getFileUrl(group.latestImageUrl),
  }));
}

// 判断文件是否为图片
// function isImage(file) {
//   return [".jpg", ".jpeg", ".png", ".avif", ".heic", ".heif", ".webp", ".gif"].includes(path.extname(file).toLowerCase());
// }

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

// ======= Sharp 编码器与克隆批量产物 =======

/**
 * 按输出扩展名选择编码器，并应用质量/效率参数
 */
function _applyEncoderByExt(pipeline, ext, quality = 80) {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return pipeline.jpeg({
        quality, // 1–100，越高越清晰越大；一般 70–85 折中
        mozjpeg: true, // 使用 mozjpeg 优化器，体积更小
        chromaSubsampling: "4:2:0", // 色度抽样，压缩更好（人眼对色敏感度低于亮度）
        trellisQuantisation: true, // 网格量化，进一步优化率失真
        overshootDeringing: true, // 去振铃伪影，边缘更干净
      });
    case "png":
      return pipeline.png({
        compressionLevel: 6, // 0–9，越高越小但更慢
        palette: true, // 尝试索引色调色板（适合扁平色/图标，能显著减小体积）
      });
    case "webp":
      return pipeline.webp({
        quality, // 有损质量；一般 35–60
        smartSubsample: true, // 智能抽样，减少色彩伪影
        effort: 3, // 0~6，越小越快；3 是很好的平衡点 effort表示编码器花多少 CPU 算力去挤压文件体积
        nearLossless: false, // 是否启用“近无损”（为 true 时更接近 PNG 特性）
      });
    case "avif":
      return pipeline.avif({
        quality, // 一般 55–90；同等主观质量下比 WebP 文件更小
        effort: Number(process.env.SHARP_AVIF_EFFORT || 3), // effort: 0–9，越大越慢、体积越小；5–7 是常见折中
        chromaSubsampling: "4:2:0", // 色度抽样，减小体积
      });
    case "heic":
    case "heif":
      return pipeline.heif({
        quality, // 1–100
        compression: "hevc", // 编码器使用 HEVC
        chromaSubsampling: "4:2:0",
      });
    default:
      return pipeline.webp({
        quality,
        smartSubsample: true,
        nearLossless: false,
      });
  }
}

/**
 * 只解码一次原图，建立一条通用管线， 然后后续生成多个版本时用 .clone() 分支出去
 */
function _createSharpBase(inputPath) {
  return sharp(inputPath, {
    failOnError: false, // 避免遇到坏图直接崩
    sequentialRead: true, // 顺序读取，减少磁盘随机 I/O
    limitInputPixels: false, // 不限制像素避免超大图被强制拒绝（如需要可设上限）
  }).rotate(); // 按 EXIF 自动旋转到正确方向
}

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
async function formatMultipleImagesFromOneSource({ inputPath, tasks }) {
  if (!tasks?.length) return { successPaths: [] };

  await Promise.all(tasks.map((t) => fsExtra.ensureDir(path.dirname(t.outputPath))));

  const base = _createSharpBase(inputPath);

  const pipelines = tasks.map((t) => {
    const ext = path.extname(t.outputPath).toLowerCase().slice(1);
    let branch = base.clone();
    if (t.resizeWidth) {
      branch = branch.resize({
        width: t.resizeWidth, //设定最大宽度
        fit: "inside", // inside 保持原图比例，把图片缩小到不超过目标宽高的最大尺寸
        withoutEnlargement: true, //如果原图本来就小于目标尺寸，不放大
        fastShrinkOnLoad: true, //在解码图片的时候，如果目标尺寸（resizeWidth / resizeHeight）明显比原图小很多，Sharp 会直接在解码阶段先用更低分辨率读取，而不是先解出原图全尺寸再去缩小。
        // kernel: sharp.kernel.lanczos2,
      });
    }
    branch = _applyEncoderByExt(branch, ext, t.quality ?? 80);
    return { branch, out: t.outputPath };
  });

  // 等“全部分支”结束
  const settled = await Promise.allSettled(pipelines.map((p) => p.branch.toFile(p.out)));

  const successPaths = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") successPaths.push(pipelines[i].out);
    else errors.push(r.reason || new Error("encode failed"));
  });

  if (errors.length) {
    const err = new Error("BATCH_ENCODE_PARTIAL_FAILURE");
    err.successPaths = successPaths; // 已经成功写到最终路径的文件
    err.errors = errors; // 失败原因列表（可用于日志）
    throw err;
  }

  return { successPaths };
}

/**
 * 单张场景 单产物转码
 */
async function formatSingleImage({ inputPath, outputPath, quality = 80, resizeWidth, withoutEnlargement = true, fit = "inside" }) {
  try {
    await fsExtra.ensureDir(path.dirname(outputPath));
    const ext = path.extname(outputPath).toLowerCase().slice(1);

    let pipeline = _createSharpBase(inputPath);

    if (resizeWidth) {
      pipeline = pipeline.resize({
        width: resizeWidth,
        fit,
        withoutEnlargement,
        fastShrinkOnLoad: true,
        // kernel: sharp.kernel.lanczos2,
      });
    }

    pipeline = _applyEncoderByExt(pipeline, ext, quality);

    await pipeline.toFile(outputPath);
  } catch (error) {
    throw error;
  }
}

// 单条回滚 图片处理过程中出错时，删除出错步骤对应的可能已处理成功的图片
async function cleanupGeneratedFile(filePath) {
  try {
    await fsExtra.remove(filePath); // 不需要先判断存在与否
  } catch (err) {
    if (err?.code === "ENOENT") return; // 不存在就当作已回滚
    throw err; // 其它错误向上抛，便于上层记录
  }
}

//批量回滚
async function rollbackMany(paths = []) {
  const results = await Promise.allSettled(paths.map((p) => fsExtra.remove(p)));
  const errors = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === "rejected" && r.reason?.code !== "ENOENT");

  if (errors.length) {
    // 这里不强制 throw；记录日志 or 聚合后抛出
    const detail = errors.map(({ r, i }) => ({ file: paths[i], err: String(r.reason?.message || r.reason) }));
    logger.warn({ message: "rollbackMany partial failures", details: detail });
  }
}

// 图片元数据提取
async function extractImageMetadata(filePath) {
  try {
    return await exiftool.read(filePath);
  } catch (error) {
    throw new CustomError({
      httpStatus: 422, // Unprocessable Entity fits “bad file / unreadable EXIF”
      messageCode: ERROR_CODES.EXIF_READ_FAILED,
      messageType: "error",
    });
  }
}

async function getAllImagesByPage({ pageNo = 1, pageSize = 10, userId, withFullUrls = true }) {
  // 参数校验和默认值保护
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectImagesByPage({ pageNo, pageSize, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = _addFullUrlsToImages(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_BY_PAGE,
      messageType: "error",
    });
  }
}

async function getImagesByYear({ pageNo = 1, pageSize = 10, yearKey = "unknown", userId, withFullUrls = true }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectImagesByYear({ pageNo, pageSize, yearKey, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = _addFullUrlsToImages(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_BY_TIME_RANGE,
      messageType: "error",
    });
  }
}

async function getImagesByMonth({ pageNo = 1, pageSize = 10, monthKey = "unknown", userId, withFullUrls = true }) {
  if (!pageNo || !pageSize || pageNo < 1 || pageSize < 1 || !userId) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    const queryResult = await imageModel.selectImagesByMonth({ pageNo, pageSize, monthKey, userId });

    // 如果需要完整URL，则转换
    if (withFullUrls && queryResult.data) {
      queryResult.data = _addFullUrlsToImages(queryResult.data);
    }

    return queryResult;
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_BY_TIME_RANGE,
      messageType: "error",
    });
  }
}

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
      queryResult.data = _addFullUrlsToGroupCover(queryResult.data);
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
      queryResult.data = _addFullUrlsToGroupCover(queryResult.data);
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

async function saveNewImage(imageData) {
  // 参数校验
  const { userId, hash, thumbnailUrl } = imageData;
  if (!userId || !hash || !thumbnailUrl) {
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

//获取用户hashes
async function getUserImageHashes(userId) {
  try {
    return await imageModel.selectHashesByUserId(userId);
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.FAILED_SELECT_ALL_DATA,
      messageType: "error",
    });
  }
}
// src/services/imageService.js 里新增
async function updateImageMetaAndHQ({ userId, hash, creationDate, monthKey, yearKey, highResUrl, originalUrl }) {
  // 你可在 imageModel 里实现 update 语句，这里只做参数校验 + 转发
  if (!userId || !hash) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }
  try {
    return await imageModel.updateMetaAndHQ({
      userId,
      hash,
      creationDate,
      monthKey,
      yearKey,
      highResUrl,
      originalUrl,
    });
  } catch (error) {
    throw error;
  }
}

module.exports = {
  updateImageMetaAndHQ,
  getUserImageHashes,
  // isImage,
  formatImage,
  isDuplicate,
  formatSingleImage,
  formatMultipleImagesFromOneSource,
  cleanupGeneratedFile,
  rollbackMany,
  extractImageMetadata,
  getAllImagesByPage,
  getImagesByMonth,
  getImagesByYear,
  getGroupsByYear,
  getGroupsByMonth,
  saveNewImage,
};
