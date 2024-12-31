/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-31 16:12:24
 * @Description: File description
 */
//这个文件后面要优化下 不要在controller中直接调用model的方法 而是统一调用service的 然后service调用model的
// 后面删掉这个
require("dotenv").config();
const path = require("path");
const fsExtra = require("fs-extra");
const fs = require("fs");
const async = require("async");
const { readFile } = require("../services/fileService");
const imageService = require("../services/imageService");
const { stringToTimestamp } = require("../utils/formatTime");
const handleErrorResponse = require("../errors/errorResponseHandler");
// const { error } = require("console");

const logFile = path.join(__dirname, "..", "..", process.env.PROCESSED_IMAGE_LOG_FILE);

// 创建日志流
const logStream = fs.createWriteStream(logFile, { flags: "a" });

function logError(message) {
  // console.error(message);
  logStream.write(message + "\n");
}

//源文件目录
const uploadFolder = path.join(__dirname, "..", "..", process.env.UPLOADS_DIR);
// 重复图片存放目录
const duplicateFolder = path.join(__dirname, "..", "..", process.env.DUPLICATE_IMAGE_DIR);
// 格式化图片后缀名
const imgExtension = process.env.PROCESSED_IMAGE_TARGET_EXTENSION;
// 存放处理成功图片的源图片文件夹
const originalFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_ORIGINAL_IMAGE_DIR);
// 转换高质量大图目录
const bigHighImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_BIG_HIGH_IMAGE_DIR);
// 转换低质量大图目录
const bigLowImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_BIG_LOW_IMAGE_DIR);
// 转换小图目录
const previewImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_PREVIEW_IMAGE_DIR);

// // 确保目标文件夹存在 若不存在 会自动创建
fsExtra.ensureDirSync(bigHighImageFolder);
fsExtra.ensureDirSync(bigLowImageFolder);
fsExtra.ensureDirSync(previewImageFolder);
fsExtra.ensureDirSync(duplicateFolder);

function _removeLeadingDigits(str) {
  return str.replace(/^\d+/, "").replace(/\./g, "dot");
}

function _incrementProcessedCount() {
  processState.processedCount++;
}

async function _processImageFormats({ sourceFilePath, bigHighFilePath, bigLowFilePath, previewFilePath }) {
  try {
    await Promise.all([
      imageService.formatImage([sourceFilePath, "-quality", "50", bigHighFilePath]),
      imageService.formatImage([sourceFilePath, "-quality", "10", bigLowFilePath]),
      imageService.formatImage([sourceFilePath, "-quality", "50", "-resize", "600x", previewFilePath]),
    ]);
  } catch (error) {
    throw error;
  }
}

async function _rollbackFile({ bigHighFilePath, bigLowFilePath, previewFilePath }) {
  try {
    await imageService.rollbackOperation(bigHighFilePath);
    await imageService.rollbackOperation(bigLowFilePath);
    await imageService.rollbackOperation(previewFilePath);
  } catch (error) {
    throw error;
  }
}

// 提取工具函数：为图片添加 Base URL
function _addBaseUrlToImages(baseUrl, images) {
  return images.map((image) => ({
    ...image,
    bigHighQualityImageUrl: `${baseUrl}${image.bigHighQualityImageUrl}`,
    bigLowQualityImageUrl: `${baseUrl}${image.bigLowQualityImageUrl}`,
    previewImageUrl: `${baseUrl}${image.previewImageUrl}`,
  }));
}

// 提取工具函数：为按年/按月份组数据封面图片添加 Base URL
function _addBaseUrlToGroupCover(baseUrl, groups) {
  return groups.map((group) => {
    return {
      ...group,
      latestImageUrl: `${baseUrl}${group.latestImageUrl}`,
    };
  });
}

function _getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

async function _safeMove(source, destination) {
  try {
    await fsExtra.move(source, destination, { overwrite: true });
  } catch (error) {
    throw error;
  }
}

async function _processImagesConcurrently(imageFiles, limit, processImageFn) {
  return new Promise((resolve, reject) => {
    async.eachLimit(imageFiles, limit, processImageFn, (error) => {
      if (error) {
        console.error("并发处理出错:", error);
        reject(error);
      } else {
        console.log(`并发任务完成，成功处理${processState.processedCount}/${imageFiles.length}张`);
        resolve();
      }
    });
  });
}

// 图片压缩处理入库
const processState = {
  processedCount: 0,
};

// 图片处理入库
async function processAndSaveImage() {
  try {
    // 读取上传文件夹
    var files = await readFile(uploadFolder);
    // 过滤出图片文件
    let imageFiles = files.filter(imageService.isImage);
    if (!imageFiles || !imageFiles.length) {
      console.log("无图片文件需要处理");
      return;
    }
    console.log("文件夹中的图片:", files);
    //新建images数据表(如果不存在)
    try {
      await imageService.setUpTableImages();
    } catch (error) {
      throw error;
    }
    // 获取数据库中所有已存储图片信息
    try {
      var existingImages = await imageService.getAllImages();
    } catch (error) {
      throw error;
    }
    // 进行图片文件处理
    async function processImage(file) {
      //  原文件路径
      const sourceFilePath = path.join(uploadFolder, file);
      // 获取图片哈希值
      try {
        var imageHash = await imageService.calculateImageHash(sourceFilePath);
      } catch (error) {
        console.error(`计算图片${sourceFilePath}哈希值出错：`, error);
        return;
      }
      // 判断数据库中是否已存在相同图片信息(在这之前应该对文件夹内部进行一次去重 这个逻辑后面补上)
      const isAlreadyExist = await imageService.isDuplicate(imageHash, existingImages);
      //   已存在 则不再进行图片处理 并将其移至重复图片文件夹存放
      if (isAlreadyExist) {
        const duplicateFilePath = path.join(duplicateFolder, path.basename(sourceFilePath));
        try {
          await _safeMove(sourceFilePath, duplicateFilePath);
          console.log(`重复图片已移动至：${duplicateFilePath}`);
        } catch (error) {
          console.error(`重复文件移动失败：${sourceFilePath} -> ${duplicateFilePath}`, error);
        }
      } else {
        // 图片格式化
        try {
          //  格式化高质量大图
          var bigHighFilePath = path.join(bigHighImageFolder, `${imageHash}.${imgExtension}`);
          //  格式化低质量大图
          var bigLowFilePath = path.join(bigLowImageFolder, `${imageHash}.${imgExtension}`);
          // 格式化小图
          var previewFilePath = path.join(previewImageFolder, `${imageHash}.${imgExtension}`);
          await _processImageFormats({ sourceFilePath, bigHighFilePath, bigLowFilePath, previewFilePath });
        } catch (error) {
          console.error(`图片文件 ${file} 格式转换失败: ${error}`);
          //将可能已转化成功的图片文件删除并跳出当前循环
          try {
            await _rollbackFile({ bigHighFilePath, bigLowFilePath, previewFilePath });
          } catch (err) {
            console.error(`图片文件 ${file} 在图片格式转化失败后，进行文件夹移动操作回滚失败: ${err}`);
          }
          return;
        }
        // 获取图片元数据
        let creationDate = null;
        try {
          var exifData = await imageService.extractImageMetadata(sourceFilePath);
          creationDate = exifData.DateTimeOriginal ? stringToTimestamp(exifData.DateTimeOriginal.rawValue) : null;
        } catch (error) {
          console.error(`获取图片${path.basename(sourceFilePath)}元数据失败：${error}`);
        }
        let imageData = {
          originalImageUrl: path.join(`/${process.env.PROCESSED_ORIGINAL_IMAGE_DIR}`, `${file}`),
          bigHighQualityImageUrl: path.join(`/${process.env.PROCESSED_BIG_HIGH_IMAGE_DIR}`, `${imageHash}.${imgExtension}`),
          bigLowQualityImageUrl: path.join(`/${process.env.PROCESSED_BIG_LOW_IMAGE_DIR}`, `${imageHash}.${imgExtension}`),
          previewImageUrl: path.join(`/${process.env.PROCESSED_PREVIEW_IMAGE_DIR}`, `${imageHash}.${imgExtension}`),
          creationDate,
          hash: imageHash,
        };
        console.log("imageData:", imageData);
        // 将没有拍摄时间的图片信息记录到日志文件中 方便排查是哪些文件
        if (!imageData.creationDate) {
          logError(`var ${_removeLeadingDigits(file)} = ${JSON.stringify(exifData)}`);
        }
        //将图片数据插入数据表
        try {
          await imageService.saveNewImage(imageData);
          // 全部操作成功后 将源图片移至original目录
          const originalFilePath = path.join(originalFolder, path.basename(sourceFilePath));
          try {
            await _safeMove(sourceFilePath, originalFilePath);
            console.log(`源文件已移动至：${originalFilePath}`);
          } catch (error) {
            console.error(`源文件移动失败：${sourceFilePath} -> ${originalFilePath}`, error);
          }
          // console.log(`上传图片已移动至：${originalFilePath}`);
          _incrementProcessedCount();
        } catch (error) {
          console.error(`图片信息插入数据表发生错误`, imageData.originalImageUrl, error);
          //将可能已转化成功的图片文件删除并跳出当前循环
          try {
            await _rollbackFile({ bigHighFilePath, bigLowFilePath, previewFilePath });
          } catch (err) {
            console.error(`图片文件 ${file} 在图片信息插入数据表错误后，进行文件夹移动操作回滚失败: ${err}`);
          }
          return;
        }
      }
    }
    // 使用 async.eachLimit 限制并发数量
    await _processImagesConcurrently(imageFiles, 4, processImage);
  } catch (error) {
    console.log("图片处理出错：", error);
    // handleErrorResponse(res, error)
  } finally {
    console.log(`图片处理完成：成功处理 ${processState.processedCount}/${imageFiles.length} 张图片`);
    if (state.errors.length) {
      console.error("以下图片处理失败：", state.errors);
    }
  }
}

// 分页获取所有图片信息
async function handleGetAllByPage(req, res) {
  const { pageNo, pageSize } = req.body;
  try {
    // 分页获取数据库中所有已存储图片信息
    const queryResult = await imageService.getAllImagesByPage({ pageNo, pageSize });

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = _addBaseUrlToImages(baseUrl, queryResult.data);

    res.status(200).json({ status: "success", data: imagesWithBaseUrl, total: queryResult.total });
  } catch (error) {
    console.error("Error fetching images by page：", error?.message);
    handleErrorResponse(res, error);
  }
}

//分页获取具体某个时间段的图片
async function handleGetByTimeRange(req, res) {
  const { pageNo, pageSize, creationDate, timeRange } = req.body;
  try {
    // 分页获取数据库中具体某个月已存储图片信息
    const queryResult = await imageService.getImagesByTimeRange({ pageNo, pageSize, creationDate, timeRange });

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = _addBaseUrlToImages(baseUrl, queryResult.data);
    res.status(200).json({ status: "success", data: imagesWithBaseUrl, total: queryResult.total });
  } catch (error) {
    console.error("Error fetching images by time range：", error?.message);
    handleErrorResponse(res, error);
  }
}

// 分页获取按年份分组数据
async function handleGroupByYear(req, res) {
  const { pageSize, pageNo } = req.body;
  try {
    // 分页获取数据
    const queryResult = await imageService.getGroupsByYear({ pageSize, pageNo });

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const groupsWithBaseUrl = _addBaseUrlToGroupCover(baseUrl, queryResult.data);
    res.status(200).json({ status: "success", data: groupsWithBaseUrl, total: queryResult.total });
  } catch (error) {
    console.error("Error fetching groups by year：", error?.message);
    handleErrorResponse(res, error);
  }
}

// 分页获取按月份分组数据
async function handleGroupByMonth(req, res) {
  const { pageSize, pageNo } = req.body;
  try {
    // 分页获取数据
    const queryResult = await imageService.getGroupsByMonth({ pageSize, pageNo });

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const groupsWithBaseUrl = _addBaseUrlToGroupCover(baseUrl, queryResult.data);
    res.status(200).json({ status: "success", data: groupsWithBaseUrl, total: queryResult.total });
  } catch (error) {
    console.error("Error fetching groups by month：", error?.message);
    handleErrorResponse(res, error);
  }
}

module.exports = {
  handleGetAllByPage,
  handleGetByTimeRange,
  handleGroupByYear,
  handleGroupByMonth,
  processAndSaveImage,
};
