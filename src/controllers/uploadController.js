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
const storageService = require("../services/storageService");
const logger = require("../utils/logger");

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

    const { size: fileSize, filename: fileName } = file;
    const userId = req?.user?.userId;

    // 第一步：先计算哈希，用于去重检查
    // 统一使用适配器处理，支持Buffer和文件路径
    const imageHash = await computeFileHash(file.buffer || file.path);

    // 第二步：检查队列中是否已存在相同的任务（提前去重）
    const jobId = `${userId}:${imageHash}`;
    const existingJob = await imageUploadQueue.getJob(jobId);

    if (existingJob) {
      // 发现重复任务，直接返回成功（不进行存储操作）
      logger.info({
        message: "Duplicate job detected, skipping storage",
        details: {
          jobId,
          userId,
          imageHash,
          fileName,
          action: "duplicate_skipped_before_storage",
        },
      });

      // 清理重复的上传文件（本地存储模式）
      if (file.path) {
        await storageService.deleteFile({ fileName, storageKey: file.path });
      }

      // 返回成功，用户无感知
      return res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY });
    }

    // 第三步：没有重复，进行存储操作
    let storageKey;
    if (file.buffer) {
      // 内存存储模式：上传到存储服务（OSS等）
      const uploadStorageKey = `upload/${fileName}`;
      await storageService.storage.storeFile(file.buffer, uploadStorageKey);
      storageKey = uploadStorageKey;

      logger.info({
        message: "File uploaded to storage service",
        details: { userId, fileName, uploadStorageKey, fileSize },
      });
    } else {
      // 磁盘存储模式：文件已通过multer中间件保存到本地 所以这里不需要再做什么操作
      storageKey = file.path;

      logger.info({
        message: "File uploaded to local storage",
        details: { userId, fileName, path: file.path, fileSize },
      });
    }

    // 第四步：添加到队列处理
    await imageUploadQueue.add(
      process.env.IMAGE_UPLOAD_QUEUE_NAME,
      {
        fileName,
        fileSize,
        storageKey, // 本地路径或存储键名
        userId,
        imageHash,
        extension: process.env.IMAGE_THUMBNAIL_EXTENSION || "webp",
        sessionId: req.body.sessionId, // 传递会话ID
      },
      {
        jobId: jobId,
      },
    );

    logger.info({
      message: "New image upload job added to queue",
      details: {
        userId,
        fileName,
        fileSize,
        storageKey,
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

    // console.log("接收到文件:", fileName, fileSize, filePath);

    // const savedFile = {
    //   fileSize,
    //   storagePath: filePath,
    //   fileName,
    // };

    res.sendResponse({ messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handlePostImages,
};
