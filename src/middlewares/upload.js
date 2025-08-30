/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 12:06:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-04 22:07:45
 * @Description: 动态上传中间件 - 根据存储类型选择不同的上传策略
 */
const multer = require("multer");
const path = require("path");
const { DateTime } = require("luxon");
const { getStorageType, STORAGE_TYPES } = require("../storage/constants/StorageTypes");

// 获取当前存储类型
const storageType = getStorageType();

// 生成文件名的通用函数
function generateFilename(req, file) {
  const ext = path.extname(file.originalname);
  const base = path.basename(file.originalname, ext);

  // 使用 Luxon 生成时间戳，支持时区配置
  const timezone = process.env.TIMEZONE || "local";
  const now = timezone.toLowerCase() === "utc" ? DateTime.utc() : DateTime.local();

  const dateTime = now.toFormat("yyyyMMdd-HHmmss");
  const userId = req?.user?.userId || "nobody";
  return `${userId}-${dateTime}-${base}${ext}`;
}

// 根据存储类型选择不同的存储策略
let storage;

if (storageType !== STORAGE_TYPES.LOCAL) {
  // OSS存储：阿里云OSS存储模式下，文件上传到内存中，不保存到本地磁盘
  storage = multer.memoryStorage();
} else {
  // 本地存储：使用磁盘存储
  const uploadFolder = path.join(__dirname, "..", "..", process.env.UPLOADS_DIR);

  storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, `${uploadFolder}/`);
    },
    filename: function (req, file, cb) {
      cb(null, generateFilename(req, file));
    },
  });
}

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

// 创建 multer 实例
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 限制单张最大50MB
});

// 创建基础的multer中间件
const uploadMiddleware = upload.single("file");

// 创建增强的上传中间件：为 OSS 存储模式添加生成的文件名 因为当文件上传到内存中时，没有文件名，只有文件流，所以需要手动生成文件名
const enhancedUpload = (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      return next(err);
    }

    // 为 OSS 存储模式添加生成的文件名
    if (storageType !== STORAGE_TYPES.LOCAL && req.file) {
      req.file.filename = generateFilename(req, req.file);
    }

    next();
  });
};

module.exports = enhancedUpload;
