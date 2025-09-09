/*
 * @Author: zhangshouchang
 * @Date: 2025-09-07 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-09-07 10:00:00
 * @Description: 预检和直传相关控制器
 */
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const storageService = require("../services/storageService");
const { getRedisClient } = require("../services/redisClient");
const { ensureUserSetReady, userSetKey } = require("../workers/userImageHashset");
const { imageUploadQueue } = require("../queues/imageUploadQueue");
const logger = require("../utils/logger");
const { verifyOSSCallbackSignature, parseCallbackData } = require("../utils/ossCallbackUtils");

/**
 * 预检文件是否存在
 * POST /images/checkFileExists
 * Body: { hash }
 */
async function handleCheckFileExists(req, res, next) {
  try {
    const { hash } = req.body;
    const userId = req?.user?.userId;

    if (!hash) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
      });
    }

    // 确保用户的 Redis hash 集合已初始化
    await ensureUserSetReady(userId);

    // 使用 Redis 检查文件是否已存在
    const redisClient = getRedisClient();
    const setKey = userSetKey(userId);
    const exists = await redisClient.sismember(setKey, hash);

    if (exists === 1) {
      // 文件已存在，返回秒传信息
      logger.info({
        message: "File exists in Redis cache",
        details: { userId, imageHash: hash },
      });
      return res.sendResponse({
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
        data: {
          exists: true,
        },
      });
    }

    return res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: {
        exists: false,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取OSS直传签名
 * POST /images/getUploadSignature
 * Body: { hash, contentType, contentLength }
 */
async function handleGetUploadSignature(req, res, next) {
  try {
    const { hash, contentType, contentLength } = req.body;
    const userId = req?.user?.userId;

    if (!hash || !contentType || !contentLength) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
      });
    }

    // 生成基于时间的storageKey（预检已处理去重，这里按时间组织便于管理）
    const fileExtension = contentType.split("/")[1] || "jpg";
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");

    // images/userId/year/month/hashPrefix/hash.ext
    const storageKey = `images/${userId}/${year}/${month}/${hash.substring(0, 2)}/${hash}.${fileExtension}`;

    // 获取OSS上传签名
    const uploadSignature = await storageService.getUploadSignature({
      storageKey,
      contentType,
      contentLength,
      userId,
    });

    return res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: uploadSignature, // 直接返回适配器的结果
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 检查去重并添加到队列
 * @param {Object} callbackData - 回调数据
 * @returns {Promise<boolean>} 是否为重复任务
 */
async function checkAndAddToQueue(callbackData) {
  const { userId, hash, fileName, fileSize, storageKey } = callbackData;
  const jobId = `${userId}_${hash}`;
  const existingJob = await imageUploadQueue.getJob(jobId);

  if (existingJob) {
    // 发现重复任务，记录日志
    logger.info({
      message: "Duplicate OSS upload job detected, skipping queue processing",
      details: {
        jobId,
        userId,
        imageHash: hash,
        storageKey,
        fileName,
        action: "duplicate_skipped_after_oss_upload",
        note: "OSS storage is overwrite-based, no cleanup needed",
      },
    });
    return true; // 是重复任务
  }

  // 没有重复，添加到队列进行后续处理（生成缩略图、EXIF提取等）
  await imageUploadQueue.add(
    process.env.IMAGE_UPLOAD_QUEUE_NAME,
    {
      fileName,
      fileSize,
      storageKey,
      userId,
      imageHash: hash,
      extension: process.env.IMAGE_THUMBNAIL_EXTENSION || "webp",
    },
    {
      jobId: jobId,
    },
  );

  return false; // 不是重复任务
}

/**
 * 阿里云OSS图片上传完成回调
 * POST /aliyunOss/imageUploadCallback
 * Body: OSS回调数据
 */
async function handleUploadCallback(req, res, next) {
  try {
    // 记录回调请求
    logger.info({
      message: "收到OSS回调请求",
      details: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
      },
    });

    // 1. 验证回调签名
    const isValid = await verifyOSSCallbackSignature(req);
    if (!isValid) {
      throw new CustomError({
        httpStatus: 403,
        messageType: "error",
        message: "Invalid OSS callback signature",
        details: {
          req,
        },
      });
    }

    logger.info({
      message: "OSS回调签名验证成功 开始解析回调数据进行图片入库",
    });

    // 2. 解析回调数据
    const callbackData = parseCallbackData(req.body);

    // 3. 检查去重并添加到队列
    await checkAndAddToQueue(callbackData);

    logger.info({
      message: "图片处理任务添加到队列成功",
    });

    // 4. 返回成功响应给OSS
    return res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    logger.error({
      message: "OSS回调处理失败",
      details: { error: error.message, stack: error.stack },
    });
    next(error);
  }
}

module.exports = {
  handleCheckFileExists,
  handleGetUploadSignature,
  handleUploadCallback,
};
