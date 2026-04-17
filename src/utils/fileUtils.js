/*
 * @Author: zhangshouchang
 * @Date: 2025-09-19
 * @Description: 文件处理工具函数
 */

/**
 * 图片格式映射表（主数据源）
 * 统一管理扩展名 ↔ MIME 类型的双向映射
 */
const IMAGE_FORMAT_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml'
}

/**
 * 支持的图片文件扩展名列表（从映射表派生）
 */
const SUPPORTED_IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_FORMAT_MAP))

/**
 * 支持的图片MIME类型列表（从映射表派生）
 */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_FORMAT_MAP))

/**
 * 视频格式映射表（扩展名 → MIME，用于入库、校验）
 */
const VIDEO_FORMAT_MAP = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  ts: 'video/mp2t',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv'
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_FORMAT_MAP))
const SUPPORTED_VIDEO_MIME_TYPES = new Set(Object.values(VIDEO_FORMAT_MAP))

/**
 * 从视频文件名解析 MIME（与 VIDEO_FORMAT_MAP 一致；未知扩展名返回 null）
 * @param {string} fileName - 含扩展名的文件名或路径
 * @returns {string|null}
 */
function getVideoMimeTypeFromFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null
  const ext = fileName.toLowerCase().trim().split('.').pop()
  if (!ext) return null
  return VIDEO_FORMAT_MAP[ext] ?? null
}

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
    return true
  }

  // 2. 降级检查：基于文件扩展名（处理HEIC等格式）
  if (file.originalname) {
    const extension = file.originalname.toLowerCase().split('.').pop()
    return SUPPORTED_IMAGE_EXTENSIONS.has(extension)
  }

  // 3. 无法判断时返回false
  return false
}

/**
 * 视频文件检测
 * @param {Object} file - multer文件对象 {originalname, mimetype, ...}
 * @returns {boolean} 是否为支持的视频文件
 */
function isVideoFile(file) {
  if (file.mimetype && SUPPORTED_VIDEO_MIME_TYPES.has(file.mimetype)) {
    return true
  }
  if (file.originalname) {
    const extension = file.originalname.toLowerCase().split('.').pop()
    return SUPPORTED_VIDEO_EXTENSIONS.has(extension)
  }
  return false
}

/**
 * 媒体文件检测（图片或视频）
 * @param {Object} file - multer文件对象
 * @returns {boolean} 是否为支持的媒体文件
 */
function isMediaFile(file) {
  return isImageFile(file) || isVideoFile(file)
}

/**
 * 从文件对象推断 mediaType（'image' | 'video'）
 * 解决 mimetype 不可靠场景（如从 Finder 拖入时为 application/octet-stream）
 * @param {Object} file - multer 文件对象 { mimetype, originalname, filename }
 * @returns {'video'|'image'}
 */
function getMediaTypeFromFile(file) {
  if (file.mimetype?.startsWith('video/')) return 'video'
  const fileName = file.originalname || file.filename || ''
  const ext = fileName.toLowerCase().split('.').pop()
  if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'image'
}

/**
 * 通过魔数（magic bytes）检测图片格式
 * 基于文件头字节判断，比扩展名更可靠
 *
 * @param {Buffer} buffer - 图片数据（建议至少 12 字节）
 * @returns {string|null} 检测到的格式或 null
 *
 * 支持格式：jpeg, png, gif, bmp, tiff, webp, svg, avif, heic, heif
 */
function detectImageFormatFromBuffer(buffer) {
  if (!buffer || buffer.length < 4) {
    return null
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png'
  }

  // GIF: GIF87a 或 GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 && // G
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x38 && // 8
    (buffer[4] === 0x37 || buffer[4] === 0x39) && // 7 或 9
    buffer[5] === 0x61 // a
  ) {
    return 'gif'
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'bmp'
  }

  // TIFF: II*\0 (little-endian) 或 MM\0* (big-endian)
  if (buffer.length >= 4) {
    if (
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) || // II*\0
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) // MM\0*
    ) {
      return 'tiff'
    }
  }

  // WebP: RIFF ... WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  ) {
    return 'webp'
  }

  // SVG: 文本格式，检查开头是否为 <svg 或 <?xml
  if (buffer.length >= 5) {
    const text = buffer.slice(0, Math.min(100, buffer.length)).toString('utf-8')
    if (text.includes('<svg') || text.includes('<?xml')) {
      return 'svg'
    }
  }

  // HEIC/HEIF/AVIF: ftyp (位于偏移4)
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 && // f
    buffer[5] === 0x74 && // t
    buffer[6] === 0x79 && // y
    buffer[7] === 0x70 // p
  ) {
    // 检查 brand（偏移8-11）
    const brand = buffer.slice(8, 12).toString('ascii')

    // AVIF 格式
    if (brand === 'avif' || brand === 'avis' || brand === 'MA1A' || brand === 'MA1B') {
      return 'avif'
    }

    // HEIC 格式（Apple HEVC）
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) {
      return 'heic'
    }

    // HEIF 格式（通用）
    if (brand === 'mif1' || brand === 'msf1') {
      return 'heif'
    }
  }

  return null
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
  let extension = input.toLowerCase().trim()

  // 如果包含点号，提取扩展名
  if (extension.includes('.')) {
    extension = extension.split('.').pop()
  }

  return IMAGE_FORMAT_MAP[extension] || 'image/jpeg'
}

/**
 * 从 MIME 类型获取文件扩展名
 *
 * @param {string} mimeType - MIME 类型（如 "image/jpeg"）
 * @returns {string} 文件扩展名（如 "jpg"），不支持的类型返回 "jpg"
 */
function getExtensionFromMimeType(mimeType) {
  // 从主映射表中查找（反向查找）
  for (const [ext, mime] of Object.entries(IMAGE_FORMAT_MAP)) {
    if (mime === mimeType) {
      return ext
    }
  }

  return 'jpg' // 默认值
}

/**
 * 增强版：通过魔数检测图片格式，并返回 MIME 类型
 * 优先使用魔数检测，失败时降级到扩展名
 *
 * @param {Buffer|string} input - Buffer（优先，用于魔数检测）或文件名/路径（降级）
 * @returns {string} 标准化的 MIME 类型
 */
function getMimeTypeByMagicBytes(input) {
  // 如果输入是 Buffer，使用魔数检测
  if (Buffer.isBuffer(input)) {
    const format = detectImageFormatFromBuffer(input)
    if (format) {
      // 直接从主映射表获取 MIME 类型（避免重复定义）
      return IMAGE_FORMAT_MAP[format] || 'image/jpeg'
    }
    // ⚠️ 魔数检测失败（Buffer 场景）
    // 可能原因：
    // 1. 文件损坏
    // 2. 非标准编码
    // 3. 不支持的格式
    // 策略：返回默认值，让后续处理（Sharp/OpenCV）自然失败
    return 'image/jpeg'
  }

  // 降级：使用扩展名判断（String 场景，如文件路径）
  if (typeof input === 'string') {
    return getStandardMimeType(input)
  }

  return 'image/jpeg'
}

module.exports = {
  isMediaFile,
  getMediaTypeFromFile,
  getVideoMimeTypeFromFileName,
  getExtensionFromMimeType,
  getMimeTypeByMagicBytes,
  SUPPORTED_IMAGE_MIME_TYPES
}
