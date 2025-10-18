/*
 * @Author: zhangshouchang
 * @Date: 2025-09-19
 * @Description: 文件处理工具函数
 */

/**
 * 支持的图片文件扩展名列表
 * 包含常见图片格式和苹果HEIC/HEIF格式
 */
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "heic", "heif", "svg"]);

/**
 * 支持的图片MIME类型列表
 * 用于优先检查浏览器提供的MIME类型
 */
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/svg+xml",
]);

/**
 * 智能图片文件检测 - 解决HEIC等格式MIME类型识别问题
 *
 * 作用：
 * 1. 优先使用multer提供的MIME类型（准确性高）
 * 2. 降级使用文件扩展名检测（兼容HEIC等格式）
 * 3. 特别处理苹果HEIC/HEIF格式的识别问题
 *
 * 背景：
 * - HEIC文件在multer中mimetype可能是application/octet-stream
 * - 需要通过文件名扩展名进行二次验证
 * - 确保所有支持的图片格式都能被正确识别
 *
 * @param {Object} file - multer文件对象 {originalname, mimetype, ...}
 * @returns {boolean} 是否为支持的图片文件
 */
function isImageFile(file) {
  // 1. 优先检查multer提供的MIME类型
  if (file.mimetype && SUPPORTED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    return true;
  }

  // 2. 降级检查：基于文件扩展名（处理HEIC等格式）
  if (file.originalname) {
    const extension = file.originalname.toLowerCase().split(".").pop();
    return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
  }

  // 3. 无法判断时返回false
  return false;
}

/**
 * 从文件名获取标准化的MIME类型
 * 用于修正错误的MIME类型（如HEIC文件的application/octet-stream）
 * 支持文件名和扩展名输入
 *
 * @param {string} input - 文件名（如 "test.jpg"）或扩展名（如 "jpg" 或 ".jpg"）
 * @returns {string} 标准化的MIME类型
 */
function getStandardMimeType(input) {
  // 支持文件名（如 "test.jpg"）和扩展名（如 "jpg" 或 ".jpg"）
  let extension = input.toLowerCase().trim();

  // 如果包含点号，提取扩展名
  if (extension.includes(".")) {
    extension = extension.split(".").pop();
  }

  const mimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    svg: "image/svg+xml",
  };

  return mimeTypes[extension] || "image/jpeg";
}

module.exports = {
  isImageFile,
  getStandardMimeType,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_MIME_TYPES,
};
