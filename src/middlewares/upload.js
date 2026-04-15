/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 12:06:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-11-03 12:00:00
 * @Description: 智能上传中间件 - 根据环境配置自动选择存储策略
 */
const multer = require('multer')
const path = require('path')
const crypto = require('crypto')
const { DateTime } = require('luxon')
const storageService = require('../services/storageService')
const { isMediaFile } = require('../utils/fileUtils')

// 视频上传大小限制（默认 10GB）
const VIDEO_MAX_FILE_SIZE = Number(process.env.VIDEO_MAX_FILE_SIZE) || 10 * 1024 * 1024 * 1024

// 生成文件名的通用函数
function generateFilename(req, file) {
  const ext = path.extname(file.originalname)
  const now = DateTime.local()
  const dateTime = now.toFormat('yyyyMMdd-HHmmss')
  const userId = req?.user?.userId || 'nobody'

  // ✅ 使用 UUID 生成唯一标识符，避免中文文件名乱码和冲突问题
  // 取 UUID 的前12位（去掉连字符），保持文件名简洁
  const uuid = crypto.randomUUID().replace(/-/g, '').substring(0, 12)

  return `${userId}-${dateTime}-${uuid}${ext}`
}

// 通过存储服务获取Multer存储配置
const storage = storageService.storage.getMulterStorage(generateFilename)

const fileFilter = (req, file, cb) => {
  // 支持图片和视频（HEIC 等格式通过 isMediaFile 内部 isImageFile 支持）
  if (isMediaFile(file)) {
    cb(null, true)
  } else {
    cb(new Error('Only image and video files are allowed'), false)
  }
}

// 创建 multer 实例 配置了存储配置 文件过滤器 限制大小 当文件大小超过限制时 会返回一个错误
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: VIDEO_MAX_FILE_SIZE }
})

// upload.single("file")表示创建一个中间件，专门处理名为file的单个文件上传 uploadMiddleware是返回的中间件函数(这个中间件的实例)
const uploadMiddleware = upload.single('file')

// 创建增强的上传中间件：为内存存储模式添加生成的文件名
const enhancedUpload = (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    // 这个回调函数会在 uploadMiddleware 完成时被调用
    // 相当于我们自定义了 uploadMiddleware 的 "next" 行为
    if (err) {
      return next(err)
    }

    // 为内存存储模式添加生成的文件名（当文件上传到内存中时，没有文件名，只有文件流）
    if (req.file && req.file.buffer && !req.file.filename) {
      req.file.filename = generateFilename(req, req.file)
    }

    next()
  })
}

module.exports = enhancedUpload
