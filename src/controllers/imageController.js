/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-27 23:43:00
 * @Description: File description
 */
// 后面删掉这个
require("dotenv").config();
const path = require("path");
const fsExtra = require("fs-extra");
const async = require("async");
const { readFile } = require("../services/fileService");
const {
  createTableImages,
  saveImageInfo,
  getAllImageInfo,
  getAllImageInfoByPage,
  getCertainTimeRangeImageInfoByPage,
  getYearCatalogInfoByPage,
  getMonthCatalogInfoByPage,
} = require("../models/imageModel");
const { stringToTimestamp } = require("../utils/formatTime");
const { isImage, isDuplicate, formatImage, rollbackOperation, calculateImageHash, extractImageMetadata } = require("../services/imageService");

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

// 图片压缩处理入库
async function processAndSaveImage() {
  let processCount = 0;
  try {
    // 读取上传文件夹
    let files = await readFile(uploadFolder);
    // 过滤出图片文件
    imageFiles = files.filter(isImage);
    if (!imageFiles || !imageFiles.length) {
      console.log("无图片文件需要处理");
      return;
    }
    console.log("文件夹中的图片:", files);
    //新建images数据表(如果不存在)
    createTableImages();
    // 获取数据库中所有已存储图片信息
    const existingImages = getAllImageInfo();
    // 进行图片文件处理
    async function processImage(file) {
      //  原文件路径
      const sourceFilePath = path.join(uploadFolder, file);
      // 判断数据库中是否已存在相同图片信息(在这之前应该对文件夹内部进行一次去重 这个逻辑后面补上)
      const isAlreadyExist = await isDuplicate(sourceFilePath, existingImages);
      //   已存在 则不再进行图片处理 并将其移至重复图片文件夹存放
      if (isAlreadyExist) {
        const duplicateFilePath = path.join(duplicateFolder, path.basename(sourceFilePath));
        await fsExtra.move(sourceFilePath, duplicateFilePath, { overwrite: true });
        console.log(`重复图片已移动至：${duplicateFilePath}`);
      } else {
        // 获取文件名(不带后缀)
        const fileName = path.parse(sourceFilePath).name;
        // 图片格式化
        try {
          //  格式化高质量大图
          var bigHighFilePath = path.join(bigHighImageFolder, `${fileName}.${imgExtension}`);
          await formatImage([sourceFilePath, "-quality", "50", bigHighFilePath]);
          //  格式化低质量大图
          var bigLowFilePath = path.join(bigLowImageFolder, `${fileName}.${imgExtension}`);
          await formatImage([sourceFilePath, "-quality", "1", bigLowFilePath]);
          // 格式化小图
          var previewFilePath = path.join(previewImageFolder, `${fileName}.${imgExtension}`);
          await formatImage([sourceFilePath, "-quality", "50", "-resize", "600x", previewFilePath]);
        } catch (err) {
          console.log(`图片文件 ${file} 格式转换失败: ${err}`);
          //将可能已转化成功的图片文件删除并跳出当前循环
          rollbackOperation(bigHighFilePath);
          rollbackOperation(bigLowFilePath);
          rollbackOperation(previewFilePath);
          return;
        }
        // 获取图片元数据
        const exifData = await extractImageMetadata(sourceFilePath);
        // console.log("元数据：", exifData.CreateDate);
        let imageData = {
          originalImageUrl: path.join(`/${process.env.PROCESSED_ORIGINAL_IMAGE_DIR}`, `${file}`),
          bigHighQualityImageUrl: path.join(`/${process.env.PROCESSED_BIG_HIGH_IMAGE_DIR}`, `${fileName}.${imgExtension}`),
          bigLowQualityImageUrl: path.join(`/${process.env.PROCESSED_BIG_LOW_IMAGE_DIR}`, `${fileName}.${imgExtension}`),
          previewImageUrl: path.join(`/${process.env.PROCESSED_PREVIEW_IMAGE_DIR}`, `${fileName}.${imgExtension}`),
          creationDate: exifData.CreateDate ? stringToTimestamp(exifData.CreateDate.rawValue) : null,
        };
        // 获取图片哈希值
        const imageHash = await calculateImageHash(sourceFilePath);
        imageData.hash = imageHash;
        console.log("imageData:", imageData);
        //将图片数据插入数据表
        try {
          await saveImageInfo(imageData);
          // 全部操作成功后 将源图片移至original目录
          const originalFilePath = path.join(originalFolder, path.basename(sourceFilePath));
          await fsExtra.move(sourceFilePath, originalFilePath, { overwrite: true });
          // console.log(`上传图片已移动至：${originalFilePath}`);
          processCount++;
        } catch (err) {
          console.log(`图片信息插入数据表发生错误`, err);
        }
      }
    }
    // 使用 async.eachLimit 限制并发数量
    async.eachLimit(imageFiles, 4, processImage, (err) => {
      if (err) {
        console.error("并发处理出错:", err);
      } else {
        console.log(`并发任务完成，成功处理${processCount}/${imageFiles.length}张`);
      }
    });
  } catch (err) {
    console.log("图片处理出错：", err);
  } finally {
  }
}

// 获取所有图片信息
function getAllImages(req, res) {
  // 资源地址 用于图片访问地址拼接
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    // 获取数据库中所有已存储图片信息
    const images = getAllImageInfo();

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = images.map((image) => {
      return {
        ...image,
        bigHighQualityImageUrl: `${baseUrl}${image.bigHighQualityImageUrl}`,
        bigLowQualityImageUrl: `${baseUrl}${image.bigLowQualityImageUrl}`,
        previewImageUrl: `${baseUrl}${image.previewImageUrl}`,
      };
    });
    // 将 imagesWithBaseUrl 数组转换成 JSON 格式，并将其发送给客户端
    res.json(imagesWithBaseUrl);
  } catch (err) {
    console.log("查询全部图片信息表出错：", err);
    res.status(500).json({ error: "internal server error" });
  }
}

// 分页获取所有图片信息
function getAllImagesByPage(req, res) {
  const { pageSize, pageNo } = req.body;
  // 资源地址 用于图片访问地址拼接
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    // 分页获取数据库中所有已存储图片信息
    const queryResult = getAllImageInfoByPage({ pageSize, pageNo });

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = queryResult.data.map((image) => {
      return {
        ...image,
        bigHighQualityImageUrl: `${baseUrl}${image.bigHighQualityImageUrl}`,
        bigLowQualityImageUrl: `${baseUrl}${image.bigLowQualityImageUrl}`,
        previewImageUrl: `${baseUrl}${image.previewImageUrl}`,
      };
    });
    res.json({ data: imagesWithBaseUrl, total: queryResult.total });
  } catch (err) {
    console.log("分页查询图片信息表出错：", err);
    res.status(500).json({ error: "internal server error" });
  }
}

//分页获取具体某个月图片信息
function getCertainTimeRangeImagesByPage(req, res) {
  const { pageSize, pageNo, creationDate, timeRange } = req.body;
  // 资源地址 用于图片访问地址拼接
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    // 分页获取数据库中具体某个月已存储图片信息
    const queryResult = getCertainTimeRangeImageInfoByPage({ pageSize, pageNo, creationDate, timeRange });

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = queryResult.data.map((image) => {
      return {
        ...image,
        bigHighQualityImageUrl: `${baseUrl}${image.bigHighQualityImageUrl}`,
        bigLowQualityImageUrl: `${baseUrl}${image.bigLowQualityImageUrl}`,
        previewImageUrl: `${baseUrl}${image.previewImageUrl}`,
      };
    });
    res.json({ data: imagesWithBaseUrl, total: queryResult.total });
  } catch (err) {
    console.log("分页查询图片信息表出错：", err);
    res.status(500).json({ error: "internal server error" });
  }
}

// 分页获取按年份分组数据
function getGroupedImagesByYearAndPage(req, res) {
  const { pageSize, pageNo } = req.body;
  // 资源地址 用于图片访问地址拼接
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    // 分页获取数据
    const queryResult = getYearCatalogInfoByPage({ pageSize, pageNo });

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = queryResult.data.map((image) => {
      return {
        ...image,
        latestImageUrl: `${baseUrl}${image.latestImageUrl}`,
      };
    });
    res.json({ data: imagesWithBaseUrl, total: queryResult.total });
  } catch (err) {
    console.log("分页查询图片信息表出错：", err);
    res.status(500).json({ error: "internal server error" });
  }
}

// 分页获取按月份分组数据
function getGroupedImagesByMonthAndPage(req, res) {
  const { pageSize, pageNo } = req.body;
  // 资源地址 用于图片访问地址拼接
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    // 分页获取数据
    const queryResult = getMonthCatalogInfoByPage({ pageSize, pageNo });

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = queryResult.data.map((image) => {
      return {
        ...image,
        latestImageUrl: `${baseUrl}${image.latestImageUrl}`,
      };
    });
    res.json({ data: imagesWithBaseUrl, total: queryResult.total });
  } catch (err) {
    console.log("分页查询图片信息表出错：", err);
    res.status(500).json({ error: "internal server error" });
  }
}

module.exports = {
  processAndSaveImage,
  getAllImages,
  getAllImagesByPage,
  getCertainTimeRangeImagesByPage,
  getGroupedImagesByYearAndPage,
  getGroupedImagesByMonthAndPage,
};
