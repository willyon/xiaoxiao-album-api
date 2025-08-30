/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:01:24
 * @Description: File description
 */
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { imageUploadQueue } = require("../queues/imageUploadQueue");
const { computeFileHash } = require("../utils/hash");
const StorageService = require("../services/StorageService");
const logger = require("../utils/logger");
const { getStorageType, STORAGE_TYPES } = require("../storage/constants/StorageTypes");

// 创建存储服务实例
const storageService = new StorageService();

// 获取当前存储类型
const storageType = getStorageType();

async function handlePostImages(req, res, next) {
  try {
    const file = req.file; //这里的file是multer中间件生成的上传文件对象
    if (!file) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.NO_UPLOAD_FILE,
        messageType: "error",
      });
    }

    const { mimetype, size, filename } = file;
    const userId = req?.user?.userId;

    // 第一步：先计算哈希，用于去重检查
    let imageHash;
    if (storageType !== STORAGE_TYPES.LOCAL) {
      // OSS模式：从内存buffer计算哈希
      imageHash = await computeFileHash(file.buffer);
    } else {
      // 本地模式：从临时文件计算哈希
      imageHash = await computeFileHash(file.path);
    }

    // 第二步：检查队列中是否已存在相同的任务（提前去重）
    const jobId = `${userId}:${imageHash}`;
    const existingJob = await imageUploadQueue.getJob(jobId);

    if (existingJob) {
      // 发现重复任务，直接返回成功（不进行存储操作）
      logger.info({
        message: "Duplicate job detected, skipping storage",
        details: {
          userId,
          imageHash,
          filename,
          storageType,
          action: "duplicate_skipped_before_storage",
        },
      });

      // 本地模式需要清理临时文件
      if (storageType === STORAGE_TYPES.LOCAL) {
        try {
          await storageService.deleteFile(file.path);
        } catch (cleanupError) {
          logger.error({
            message: "Failed to cleanup temporary file",
            details: { path: file.path, filename, error: cleanupError.message },
          });
        }
      }

      // 返回成功，用户无感知
      return res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY });
    }

    // 第三步：没有重复，进行存储操作
    let storageKey;
    if (storageType !== STORAGE_TYPES.LOCAL) {
      // OSS存储模式：上传到OSS
      const uploadStorageKey = `uploads/${filename}`;
      await storageService.storeFile(file.buffer, uploadStorageKey);
      storageKey = uploadStorageKey;

      logger.info({
        message: "File uploaded to OSS",
        details: { userId, filename, uploadStorageKey, size },
      });
    } else {
      // 本地存储模式：文件已通过multer保存到本地
      storageKey = file.path;

      logger.info({
        message: "File uploaded to local storage",
        details: { userId, filename, path: file.path, size },
      });
    }

    // 第四步：添加到队列处理
    await imageUploadQueue.add(
      process.env.IMAGE_UPLOAD_QUEUE_NAME,
      {
        filename,
        mimetype,
        size,
        storageKey, // 本地路径或OSS键名
        userId,
        imageHash,
        storageType, // 传递存储类型给Worker
      },
      {
        jobId: jobId,
      },
    );

    logger.info({
      message: "New image upload job added to queue",
      details: {
        userId,
        filename,
        storageType,
      },
    });

    // 加入队列任务前，打印队列状态
    // const jobCounts = await imageUploadQueue.getJobCounts();
    // console.log("当前队列状态：", jobCounts);

    // const waitingJobs = await imageUploadQueue.getWaiting();
    // console.log("当前队列等待状态：", waitingJobs);
    // waitingJobs.forEach((job, index) => {
    //   console.log(`等待任务 ${index + 1}:`);
    //   console.log("任务 ID:", job.id);
    //   console.log("任务名称:", job.name);
    //   console.log("任务数据:", job.data);
    // });

    // console.log("接收到文件:", filename, mimetype, size, filePath);

    // const savedFile = {
    //   mimeType: mimetype,
    //   size,
    //   storagePath: filePath,
    //   filename,
    // };

    res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handlePostImages,
};
