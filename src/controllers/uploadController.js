/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:01
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 00:31:22
 * @Description: File description
 */
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { uploadQueue } = require("../queues/uploadQueue");

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

    // 加入队列任务
    await uploadQueue.add("processImage", {
      filename,
      originalname,
      mimetype,
      size,
      path,
      userId: req?.user?.userId,
    });

    // 加入队列任务前，打印队列状态
    const jobCounts = await uploadQueue.getJobCounts();
    console.log("当前队列状态：", jobCounts);

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

    res.sendResponse({
      messageCode: SUCCESS_CODES.FILE_UPLOADED_SUCCESSFULLY,
      //   data: savedFile,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handlePostImages,
};
