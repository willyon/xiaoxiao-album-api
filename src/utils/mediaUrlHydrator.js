const storageService = require('../services/storageService')
const logger = require('./logger')

/**
 * 安全获取存储键对应的可访问 URL，失败时返回 null。
 * @param {string|null|undefined} storageKey - 存储键。
 * @param {string} warnMessage - 失败日志消息。
 * @returns {Promise<string|null>} URL 或 null。
 */
async function resolveStorageKeyUrl(storageKey, warnMessage) {
  if (!storageKey) return null
  try {
    return await storageService.getFileUrl(storageKey)
  } catch (error) {
    logger.warn({
      message: warnMessage,
      details: { storageKey, error: error?.message || String(error) }
    })
    return null
  }
}

/**
 * 批量补齐媒体 URL 字段。
 * @param {Array<object>} items - 媒体列表。
 * @param {{mediaTypeKey?:string,thumbnailKey?:string,highResKey?:string,originalKey?:string,dropStorageKeys?:boolean}} [options] - 可选配置。
 * @returns {Promise<Array<object>>} 补齐后的媒体列表。
 */
async function hydrateMediaUrls(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return Array.isArray(items) ? items : []
  const {
    mediaTypeKey = 'mediaType',
    thumbnailKey = 'thumbnailStorageKey',
    highResKey = 'highResStorageKey',
    originalKey = 'originalStorageKey',
    dropStorageKeys = false
  } = options

  const hydrated = await Promise.all(
    items.map(async (item) => {
      const mediaType = item?.[mediaTypeKey]
      const thumbnailStorageKey = item?.[thumbnailKey]
      const highResStorageKey = item?.[highResKey]
      const originalStorageKey = item?.[originalKey]
      const needsOriginalUrl = mediaType === 'video' || !highResStorageKey

      const thumbnailUrl = await resolveStorageKeyUrl(thumbnailStorageKey, '获取缩略图 URL 失败')
      const highResUrl = await resolveStorageKeyUrl(highResStorageKey, '获取高清图 URL 失败')
      const originalUrl = needsOriginalUrl
        ? await resolveStorageKeyUrl(originalStorageKey, '获取原片 URL 失败')
        : null

      const next = {
        ...item,
        thumbnailUrl,
        highResUrl,
        originalUrl
      }

      if (dropStorageKeys) {
        delete next[thumbnailKey]
        delete next[highResKey]
        delete next[originalKey]
      }
      return next
    })
  )

  return hydrated
}

module.exports = {
  resolveStorageKeyUrl,
  hydrateMediaUrls
}
