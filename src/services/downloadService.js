/*
 * @Description: 媒体下载（单文件 buffer、批量 ZIP）业务逻辑
 */
const path = require('path')
const archiver = require('archiver')
const { DateTime } = require('luxon')
const storageService = require('./storageService')
const mediaService = require('./mediaService')
const logger = require('../utils/logger')

/** 未配置环境变量时的默认批量上限（面向本地 Electron：同机无公网滥用，主要受本机内存与压缩耗时约束） */
const DEFAULT_DOWNLOAD_BATCH_MAX = 5000
/** 硬上限：防止误填极大数字导致 OOM；需要更大可再调此常量或改为可配置 */
const ABSOLUTE_DOWNLOAD_BATCH_MAX = 50000

/**
 * 批量下载单次最多张数。
 * 环境变量 DOWNLOAD_BATCH_MAX；未设置或无效时用默认；最终限制在 [1, ABSOLUTE_DOWNLOAD_BATCH_MAX]。
 */
const DOWNLOAD_BATCH_MAX = Math.max(
  1,
  Math.min(Number(process.env.DOWNLOAD_BATCH_MAX) || DEFAULT_DOWNLOAD_BATCH_MAX, ABSOLUTE_DOWNLOAD_BATCH_MAX)
)

/**
 * 从存储键提取文件名。
 * @param {string|null|undefined} storageKey - 存储键。
 * @returns {string|null} 文件名或 null。
 */
function extractFileNameFromStorageKey(storageKey) {
  if (!storageKey) return null
  const fileName = path.basename(storageKey)
  return fileName || null
}

/**
 * 根据文件名推断 Content-Type。
 * @param {string} fileName - 文件名。
 * @returns {string} MIME 类型。
 */
function getContentTypeFromFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase()
  const contentTypeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo'
  }
  return contentTypeMap[ext] || 'application/octet-stream'
}

/**
 * 选择下载优先使用的存储键。
 * @param {{originalStorageKey?:string|null,highResStorageKey?:string|null}} payload - 存储键集合。
 * @returns {string|null} 选中的存储键或 null。
 */
function pickStorageKeyForDownload({ originalStorageKey, highResStorageKey }) {
  return originalStorageKey || highResStorageKey || null
}

/** ZIP 内文件名冲突时加序号（与历史 controller 行为一致） */
/**
 * 为 ZIP 内重复文件名追加序号避免冲突。
 * @param {string} fileName - 原始文件名。
 * @param {Map<string, number>} fileNameMap - 文件名计数表。
 * @returns {string} 去重后的文件名。
 */
function applyZipFileNameDedup(fileName, fileNameMap) {
  let name = fileName
  if (fileNameMap.has(name)) {
    const count = fileNameMap.get(name)
    const ext = path.extname(name)
    const baseName = path.basename(name, ext)
    name = `${baseName}_${count}${ext}`
    fileNameMap.set(name, 1)
  } else {
    fileNameMap.set(name, 1)
  }
  return name
}

/**
 * 单张媒体下载：buffer + 文件名 + Content-Type
 * @param {number|string} userId - 用户 ID。
 * @param {number|string} mediaId - 媒体 ID。
 * @returns {Promise<{buffer:Buffer,fileName:string,contentType:string}>} 下载数据。
 * @throws {Error} message 为「图片不存在」「图片文件不存在」「获取图片文件失败」等与 controller 约定一致
 */
async function getSingleMediaDownloadData(userId, mediaId) {
  try {
    const image = await mediaService.getMediaDownloadInfo({ userId, mediaId })
    if (!image) {
      throw new Error('图片不存在')
    }

    const storageKey = pickStorageKeyForDownload(image)
    if (!storageKey) {
      throw new Error('图片文件不存在')
    }

    const buffer = await storageService.storage.getFileBuffer(storageKey)
    if (!buffer) {
      throw new Error('获取图片文件失败')
    }

    const fileName = extractFileNameFromStorageKey(storageKey) || `image_${mediaId}.jpg`
    const contentType = getContentTypeFromFileName(fileName)

    return { buffer, fileName, contentType }
  } catch (error) {
    logger.error({
      message: '获取单张图片下载失败',
      details: { mediaId, userId, error: error.message }
    })
    throw error
  }
}

/**
 * 批量打包为 ZIP（archiver 实例，尚未 pipe / finalize）
 * @param {number|string} userId - 用户 ID。
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {Promise<import('archiver').Archiver>} ZIP 归档实例。
 * @throws {Error} message 为「图片ID列表为空」「未找到任何图片」
 */
async function createBatchMediaZipArchive(userId, mediaIds) {
  if (!mediaIds || mediaIds.length === 0) {
    throw new Error('图片ID列表为空')
  }

  try {
    const images = await mediaService.getMediasDownloadInfo({ userId, mediaIds })
    if (!images || images.length === 0) {
      throw new Error('未找到任何图片')
    }

    const archive = archiver('zip', { zlib: { level: 9 } })
    const fileNameMap = new Map()

    for (const image of images) {
      const { id: mediaId, originalStorageKey, highResStorageKey } = image
      const storageKey = pickStorageKeyForDownload({ originalStorageKey, highResStorageKey })
      if (!storageKey) {
        logger.warn({
          message: '图片文件不存在，跳过',
          details: { mediaId }
        })
        continue
      }

      try {
        const buffer = await storageService.storage.getFileBuffer(storageKey)
        if (!buffer) {
          logger.warn({
            message: '获取图片文件失败，跳过',
            details: { mediaId, storageKey }
          })
          continue
        }

        const rawName = extractFileNameFromStorageKey(storageKey) || `image_${mediaId}.jpg`
        const fileName = applyZipFileNameDedup(rawName, fileNameMap)
        archive.append(buffer, { name: fileName })
      } catch (error) {
        logger.warn({
          message: '处理图片时出错，跳过',
          details: { mediaId, error: error.message }
        })
      }
    }

    return archive
  } catch (error) {
    logger.error({
      message: '获取批量图片下载失败',
      details: { mediaIds, userId, error: error.message }
    })
    throw error
  }
}

/**
 * 构建批量下载 ZIP 文件名。
 * @returns {string} ZIP 文件名。
 */
function buildBatchZipDownloadFileName() {
  const timestamp = DateTime.local().toFormat('yyyy-MM-dd HH:mm:ss').replace(/ /g, '_').replace(/:/g, '-')
  return `photos_${timestamp}.zip`
}

module.exports = {
  DOWNLOAD_BATCH_MAX,
  getSingleMediaDownloadData,
  createBatchMediaZipArchive,
  buildBatchZipDownloadFileName
}
