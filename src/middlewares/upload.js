/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 12:06:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-04 22:07:45
 * @Description: 智能上传中间件 - 根据环境配置自动选择存储策略
 */
const multer = require("multer");
const path = require("path");
const { DateTime } = require("luxon");
const storageService = require("../services/storageService");
const { isImageFile } = require("../utils/fileUtils");

// 生成文件名的通用函数
function generateFilename(req, file) {
  const ext = path.extname(file.originalname);
  const base = path.basename(file.originalname, ext);

  // 使用 Luxon 生成时间戳，支持时区配置
  // const timezone = process.env.TIMEZONE || "local";
  // const now = timezone.toLowerCase() === "utc" ? DateTime.utc() : DateTime.local();
  const now = DateTime.local();

  const dateTime = now.toFormat("yyyyMMdd-HHmmss");
  const userId = req?.user?.userId || "nobody";
  return `${userId}-${dateTime}-${base}${ext}`;
}

// 通过存储服务获取Multer存储配置
const storage = storageService.storage.getMulterStorage(generateFilename);

const fileFilter = (req, file, cb) => {
  // 使用智能图片检测，支持HEIC等格式
  if (isImageFile(file)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

// 创建 multer 实例 配置了存储配置 文件过滤器 限制大小 当文件大小超过限制时 会返回一个错误
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 限制单张最大50MB
});

// upload.single("file")表示创建一个中间件，专门处理名为file的单个文件上传 uploadMiddleware是返回的中间件函数(这个中间件的实例)
const uploadMiddleware = upload.single("file");

// 创建增强的上传中间件：为内存存储模式添加生成的文件名
const enhancedUpload = (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    // 这个回调函数会在 uploadMiddleware 完成时被调用
    // 相当于我们自定义了 uploadMiddleware 的 "next" 行为
    if (err) {
      return next(err);
    }

    // 为内存存储模式添加生成的文件名（当文件上传到内存中时，没有文件名，只有文件流）
    if (req.file && req.file.buffer && !req.file.filename) {
      req.file.filename = generateFilename(req, req.file);
    }

    next();
  });
};

module.exports = enhancedUpload;
