/*
 * @Author: zhangshouchang
 * @Date: 2025-01-23
 * @Description: 图片下载控制器 - 包含数据库查询、业务逻辑和HTTP处理
 */
const storageService = require("../services/storageService");
const mediaService = require("../services/mediaService");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const logger = require("../utils/logger");

/** 批量下载单次最多张数（与内存/超时权衡，见产品讨论） */
const DOWNLOAD_BATCH_MAX = 100;
const archiver = require("archiver");
const path = require("path");
const { DateTime } = require("luxon");

// ========== 业务逻辑层 ==========

/**
 * 从storageKey提取文件名
 */
function _extractFileNameFromStorageKey(storageKey) {
  if (!storageKey) return null;
  const fileName = path.basename(storageKey);
  return fileName || null;
}

/**
 * 根据文件名获取Content-Type
 */
function _getContentTypeFromFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const contentTypeMap = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
  };
  return contentTypeMap[ext] || "application/octet-stream";
}

/**
 * 获取单张图片的下载数据
 */
async function _getSingleImageDownload(imageId, userId) {
  try {
    // 通过 service 查询图片信息
    const image = await mediaService.getMediaDownloadInfo({ userId, imageId });
    if (!image) {
      throw new Error("图片不存在");
    }

    const { originalStorageKey, highResStorageKey } = image;

    // 优先使用原图，如果不存在则使用高清图
    let storageKey = originalStorageKey || highResStorageKey;
    if (!storageKey) {
      throw new Error("图片文件不存在");
    }

    // 获取文件Buffer
    const buffer = await storageService.storage.getFileBuffer(storageKey);
    if (!buffer) {
      throw new Error("获取图片文件失败");
    }

    // 从storageKey提取文件名
    const fileName = _extractFileNameFromStorageKey(storageKey) || `image_${imageId}.jpg`;

    // 根据文件扩展名确定Content-Type
    const contentType = _getContentTypeFromFileName(fileName);

    return {
      buffer,
      fileName,
      contentType,
    };
  } catch (error) {
    logger.error({
      message: "获取单张图片下载失败",
      details: { imageId, userId, error: error.message },
    });
    throw error;
  }
}

/**
 * 获取批量图片的ZIP下载流
 */
async function _getBatchImagesDownload(imageIds, userId) {
  try {
    if (!imageIds || imageIds.length === 0) {
      throw new Error("图片ID列表为空");
    }

    // 通过 service 查询图片信息
    const images = await mediaService.getMediasDownloadInfo({ userId, imageIds });
    if (!images || images.length === 0) {
      throw new Error("未找到任何图片");
    }

    // 创建ZIP归档
    const archive = archiver("zip", {
      zlib: { level: 9 }, // 最高压缩级别
    });

    // 处理每张图片
    const fileNameMap = new Map(); // 用于处理文件名冲突
    for (const image of images) {
      const { id: imageId, originalStorageKey, highResStorageKey } = image;

      // 优先使用原图，如果不存在则使用高清图
      let storageKey = originalStorageKey || highResStorageKey;
      if (!storageKey) {
        logger.warn({
          message: "图片文件不存在，跳过",
          details: { imageId },
        });
        continue;
      }

      try {
        // 获取文件Buffer
        const buffer = await storageService.storage.getFileBuffer(storageKey);
        if (!buffer) {
          logger.warn({
            message: "获取图片文件失败，跳过",
            details: { imageId, storageKey },
          });
          continue;
        }

        // 从storageKey提取文件名
        let fileName = _extractFileNameFromStorageKey(storageKey) || `image_${imageId}.jpg`;

        // 处理文件名冲突：如果文件名已存在，添加序号
        if (fileNameMap.has(fileName)) {
          const count = fileNameMap.get(fileName);
          const ext = path.extname(fileName);
          const baseName = path.basename(fileName, ext);
          fileName = `${baseName}_${count}${ext}`;
          fileNameMap.set(fileName, 1);
        } else {
          fileNameMap.set(fileName, 1);
        }

        // 添加到ZIP
        archive.append(buffer, { name: fileName });
      } catch (error) {
        logger.warn({
          message: "处理图片时出错，跳过",
          details: { imageId, error: error.message },
        });
        continue;
      }
    }

    return archive;
  } catch (error) {
    logger.error({
      message: "获取批量图片下载失败",
      details: { imageIds, userId, error: error.message },
    });
    throw error;
  }
}

// ========== HTTP控制器层 ==========

/**
 * 单张图片下载
 * GET /images/download/:imageId
 */
async function handleDownloadSingleMedia(req, res, next) {
  try {
    const { userId } = req?.user;
    const { mediaId } = req.params;

    if (!mediaId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    const { buffer, fileName, contentType } = await _getSingleImageDownload(parseInt(mediaId), userId);

    // 设置响应头
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Content-Length", buffer.length);

    // 发送文件
    res.send(buffer);
  } catch (error) {
    if (error.message === "图片不存在" || error.message === "图片文件不存在") {
      return next(
        new CustomError({
          httpStatus: 404,
          messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
          messageType: "error",
        }),
      );
    }
    next(error);
  }
}

/**
 * 批量图片下载（ZIP）
 * POST /images/download/batch
 */
async function handleDownloadBatchMedias(req, res, next) {
  try {
    const { userId } = req?.user;
    const { mediaIds } = req.body;

    if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
      });
    }

    // 限制批量下载数量
    if (mediaIds.length > DOWNLOAD_BATCH_MAX) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.DOWNLOAD_BATCH_LIMIT_EXCEEDED,
        messageType: "warning",
        details: { max: DOWNLOAD_BATCH_MAX },
      });
    }

    const archive = await _getBatchImagesDownload(
      mediaIds.map((id) => parseInt(id)),
      userId,
    );

    // 生成ZIP文件名（使用本地时间，格式：yyyy-MM-dd HH:mm:ss，文件名中空格替换为下划线，冒号替换为连字符）
    const timestamp = DateTime.local().toFormat("yyyy-MM-dd HH:mm:ss").replace(/ /g, "_").replace(/:/g, "-");
    const zipFileName = `photos_${timestamp}.zip`;

    // 设置响应头
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(zipFileName)}"`);

    // 流式传输ZIP文件
    archive.pipe(res);

    // 处理错误
    archive.on("error", (err) => {
      logger.error({
        message: "ZIP归档创建失败",
        details: { error: err.message },
      });
      if (!res.headersSent) {
        next(
          new CustomError({
            httpStatus: 500,
            messageCode: ERROR_CODES.SERVER_ERROR,
            messageType: "error",
          }),
        );
      }
    });

    // 完成归档
    archive.finalize();
  } catch (error) {
    if (error.message === "未找到任何图片" || error.message === "图片ID列表为空") {
      return next(
        new CustomError({
          httpStatus: 404,
          messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
          messageType: "error",
        }),
      );
    }
    next(error);
  }
}

module.exports = {
  handleDownloadSingleMedia,
  handleDownloadBatchMedias,
};
