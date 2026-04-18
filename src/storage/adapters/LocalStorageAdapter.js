/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 本地文件系统存储适配器
 */

const path = require('path')
const fsExtra = require('fs-extra')
const multer = require('multer')
const BaseStorageAdapter = require('./BaseStorageAdapter')
const logger = require('../../utils/logger')

class LocalStorageAdapter extends BaseStorageAdapter {
  constructor(config = {}) {
    super(config)
    this.type = config.storageType

    // 设置默认的 baseUrl，优先使用配置，其次使用环境变量，最后使用默认值
    // 默认端口使用常见的开发端口，可通过环境变量 PORT 动态调整
    const defaultPort = process.env.PORT || 3000
    this.baseUrl = config.baseUrl || process.env.API_BASE_URL_LOCAL || `http://localhost:${defaultPort}`

    // 设置基础目录为项目根目录
    this.baseDir = path.join(__dirname, '..', '..', '..')
  }

  /**
   * 获取完整的文件系统路径
   * @param {string} filePath - 文件存储路径
   * @returns {string} 完整路径
   */
  getFullPath(filePath) {
    return path.isAbsolute(filePath) ? filePath : path.join(this.baseDir, filePath)
  }

  /**
   * 生成处理后图片的存储键名
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} fileName - 原始文件名
   * @param {string} [extension] - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')，不传则使用fileName本身
   * @returns {string} 存储键名
   */
  generateStorageKey(type, fileName, extension) {
    const targetDir = this.resolveMediaDirByType(type)
    const storedFileName = this.buildStoredFileName(fileName, extension)
    return `${targetDir}/${storedFileName}`
  }

  resolveMediaDirByType(type) {
    switch (type) {
      case process.env.MEDIA_STORAGE_KEY_THUMBNAIL || 'thumbnail':
        return process.env.PROCESSED_THUMBNAIL_MEDIA_DIR || 'storage-local/processed/thumbnails'
      case process.env.MEDIA_STORAGE_KEY_HIGHRES || 'highres':
        return process.env.PROCESSED_HIGH_RES_MEDIA_DIR || 'storage-local/processed/highres'
      case process.env.MEDIA_STORAGE_KEY_ORIGINAL || 'original':
        return process.env.PROCESSED_ORIGINAL_MEDIA_DIR || 'storage-local/processed/original'
      case process.env.MEDIA_STORAGE_KEY_FAILED || 'failed':
        return process.env.FAILED_MEDIA_DIR || 'storage-local/processing/failed'
      default:
        throw new Error(`Unknown media type: ${type}`)
    }
  }

  buildStoredFileName(fileName, extension) {
    if (!extension) return fileName
    const baseName = path.basename(fileName, path.extname(fileName))
    return `${baseName}.${extension}`
  }

  // ========== 基础文件操作实现 ==========

  /**
   * 获取文件数据（本地存储返回绝对路径）
   * @param {string} targetPath - 目标文件路径
   * @returns {Promise<string>} 绝对文件路径
   */
  async getFileData(targetPath) {
    return this.getFullPath(targetPath)
  }

  /**
   * 获取Multer存储配置 - 本地磁盘存储
   * @param {Function} generateFilename - 文件名生成函数
   * @returns {Object} Multer diskStorage配置
   */
  getMulterStorage(generateFilename) {
    const uploadFolder = path.join(__dirname, '..', '..', '..', process.env.UPLOADS_DIR)

    return multer.diskStorage({
      destination: function (req, file, cb) {
        cb(null, `${uploadFolder}/`)
      },
      filename: function (req, file, cb) {
        cb(null, generateFilename(req, file))
      }
    })
  }

  /**
   * 获取文件大小（本地存储）
   * @param {string|Buffer} input - 输入数据，可以是文件路径或Buffer
   * @returns {Promise<number>} 文件大小（字节）
   */
  async getFileSize(input) {
    if (Buffer.isBuffer(input)) {
      return input.length
    } else if (typeof input === 'string') {
      try {
        // 如果是相对路径，转换为绝对路径
        const fullPath = path.isAbsolute(input) ? input : this.getFullPath(input)
        const stats = await fsExtra.stat(fullPath)
        return stats.size
      } catch (error) {
        logger.error(`获取本地文件大小失败: ${error.message}`, {
          input,
          error: error.stack
        })
        // 返回默认大小
        return 1 * 1024 * 1024 // 1MB
      }
    }
    return 1 * 1024 * 1024 // 默认1MB
  }

  /**
   * 上传文件到本地存储
   * @param {Buffer|string} fileData - 文件数据(Buffer)或源文件路径(string)
   * @param {string} targetPath - 目标文件路径（如: storage-local/processed/highres/user123-20250829-143022-photo.png）
   * @returns {Promise<string>} 返回文件访问URL
   */
  async storeFile(fileData, targetPath) {
    try {
      const fullPath = this.getFullPath(targetPath)

      // 确保目标目录存在 path.dirname返回文件路径的目录部分
      await fsExtra.ensureDir(path.dirname(fullPath))

      if (Buffer.isBuffer(fileData)) {
        // 如果是Buffer，直接写入
        await fsExtra.writeFile(fullPath, fileData)
      } else if (typeof fileData === 'string') {
        // 如果是文件路径，复制文件
        await fsExtra.copy(fileData, fullPath, { overwrite: true })
      } else {
        throw new Error('fileData must be Buffer or file path string')
      }

      // 上传成功，返回存储路径（不生成URL）
      return fullPath
    } catch (error) {
      logger.error({
        message: 'Local storage upload failed',
        details: { targetPath, error: error.message }
      })
      throw error
    }
  }

  /**
   * 删除本地文件
   * @param {string} key - 存储键名
   * @returns {Promise<void>}
   */
  async deleteFile(key) {
    try {
      const fullPath = this.getFullPath(key)
      await fsExtra.remove(fullPath)
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 文件不存在，认为删除成功
        return
      }
      logger.error({
        message: 'Local storage delete failed',
        details: { key, error: error.message }
      })
      throw error
    }
  }

  /**
   * 移动本地文件
   * @param {string} fromKey - 源文件键名
   * @param {string} toKey - 目标文件键名
   * @returns {Promise<void>}
   */
  async moveFile(fromKey, toKey) {
    try {
      const fromPath = this.getFullPath(fromKey)
      const toPath = this.getFullPath(toKey)

      // 确保目标目录存在
      await fsExtra.ensureDir(path.dirname(toPath))

      await fsExtra.move(fromPath, toPath, { overwrite: true })
    } catch (error) {
      logger.error({
        message: 'Local storage move failed',
        details: { fromKey, toKey, error: error.message }
      })
      throw error
    }
  }

  /**
   * 检查本地文件是否存在
   * @param {string} key - 存储键名
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    try {
      const fullPath = this.getFullPath(key)
      return await fsExtra.pathExists(fullPath)
    } catch (error) {
      logger.error({
        message: 'Local storage exists check failed',
        details: { key, error: error.message }
      })
      return false
    }
  }

  /**
   * 获取本地文件内容的Buffer
   * @param {string} key - 存储键名
   * @returns {Promise<Buffer>} 文件内容的Buffer
   */
  async getFileBuffer(key) {
    try {
      const fullPath = this.getFullPath(key)
      return await fsExtra.readFile(fullPath)
    } catch (error) {
      logger.error({
        message: 'Local storage read file failed',
        details: { key, fullPath: this.getFullPath(key), error: error.message }
      })
      throw error
    }
  }

  // ========== URL 生成实现 ==========

  /**
   * 获取本地文件访问URL
   * @param {string|null} fullPath - 存储键名，如果为null或空字符串则返回null
   * @param {string} type - 文件类型（本地存储忽略此参数）
   * @returns {string|null} 文件访问URL，如果fullPath为空则返回null
   */
  getFileUrl(fullPath) {
    // 如果fullPath为空，直接返回null
    if (!fullPath || typeof fullPath !== 'string' || fullPath.trim() === '') {
      logger.info({
        message: '拼接图片URL时发现fullPath为空，跳过URL生成',
        details: {
          fullPath,
          step: 'getFileUrl',
          action: 'skip_url_generation'
        }
      })
      return null
    }

    // 本地存储直接返回相对URL
    return `${this.baseUrl}/${fullPath}`
  }

  // ========== 批量删除 ==========

  /**
   * 批量删除文件（本地存储优化版本）
   * @param {Array<string>} keys - 存储键名数组
   * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>}
   */
  async deleteFiles(keys) {
    const results = []

    // 并行处理提高效率
    const promises = keys.map(async (key) => {
      try {
        await this.deleteFile(key)
        return { key, success: true }
      } catch (error) {
        return { key, success: false, error: error.message }
      }
    })

    const settled = await Promise.allSettled(promises)

    settled.forEach((result) => {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        results.push({
          key: 'unknown',
          success: false,
          error: result.reason?.message || 'Unknown error'
        })
      }
    })

    return results
  }
}

module.exports = LocalStorageAdapter
