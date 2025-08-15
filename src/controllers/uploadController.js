/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-15 16:11:12
 * @Description: File description
 */
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { uploadQueue } = require("../queues/uploadQueue");
const { computeFileHash } = require("../utils/hash");

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

    const { originalname, mimetype, size, path, filename } = file;
    const userId = req?.user?.userId;

    // 加入队列任务

    // 先算哈希（流式，极低额外开销）
    const imageHash = await computeFileHash(path);

    // 用 userId + hash 作为唯一 jobId，避免重复入队
    await uploadQueue.add(
      "processImage",
      { filename, originalname, mimetype, size, path, userId, imageHash },
      {
        jobId: `${userId}:${imageHash}`,
      },
    );

    // 加入队列任务前，打印队列状态
    // const jobCounts = await uploadQueue.getJobCounts();
    // console.log("当前队列状态：", jobCounts);

    // const waitingJobs = await uploadQueue.getWaiting();
    // console.log("当前队列等待状态：", waitingJobs);
    // waitingJobs.forEach((job, index) => {
    //   console.log(`等待任务 ${index + 1}:`);
    //   console.log("任务 ID:", job.id);
    //   console.log("任务名称:", job.name);
    //   console.log("任务数据:", job.data);
    // });

    // console.log("接收到文件:", originalname, mimetype, size, filePath);

    // const savedFile = {
    //   originalName: originalname,
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
