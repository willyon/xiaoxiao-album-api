/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 阿里云 OSS 存储适配器（编排层；客户端/鉴权见 ossClientFactory，直传签名见 uploadSignature）
 */

const fsExtra = require('fs-extra')
const multer = require('multer')
const BaseStorageAdapter = require('../BaseStorageAdapter')
const logger = require('../../../utils/logger')
const { getMimeTypeByMagicBytes } = require('../../../utils/fileUtils')
const { initAliyunOssClients } = require('./ossClientFactory')
const { handleOssError } = require('./ossErrors')
const { getUploadSignature: buildUploadSignature } = require('./uploadSignature')

/**
 * 阿里云 OSS 存储适配器：实现与 {@link LocalStorageAdapter} 相同的基类契约，
 * 并增加 OSS 客户端初始化、签名 URL、表单直传签名等能力。详细配置说明见历史版本或运维文档。
 */
class AliyunOSSAdapter extends BaseStorageAdapter {
  /**
   * 构造 OSS 存储适配器。
   * @param {object} [config={}] - 适配器配置。
   */
  constructor(config = {}) {
    super(config)
    this.type = config.storageType
    this.config = config[config.ossAuthType]

    this._initPromise = this._initClient()
  }

  /**
   * 异步初始化 OSS 客户端与运行时上下文。
   * @returns {Promise<void>} 无返回值。
   */
  async _initClient() {
    const runtime = await initAliyunOssClients(this.config)
    this.client = runtime.client
    this.signer = runtime.signer
    this.credential = runtime.credential
    this.baseUrl = runtime.baseUrl
    this.bucket = runtime.bucket
    this.region = runtime.region
    this.accessKeyId = runtime.accessKeyId
    this.accessKeySecret = runtime.accessKeySecret
    this.stsToken = runtime.stsToken
  }

  /**
   * 确保 OSS 客户端已完成初始化。
   * @returns {Promise<void>} 无返回值。
   */
  async _ensureClient() {
    if (!this.client) {
      if (!this._initPromise) this._initPromise = this._initClient()

      try {
        await this._initPromise
      } catch (e) {
        this._initPromise = null
        throw e
      }
    }
  }

  /**
   * 统一处理 OSS 错误。
   * @param {Error & {code?:string,status?:number,requestId?:string}} error - 错误对象。
   * @param {string} operation - 操作名称。
   * @param {object} [context={}] - 附加上下文。
   * @returns {never} 总是抛出异常。
   */
  _handleOSSError(error, operation, context = {}) {
    handleOssError(logger, error, operation, context)
  }

  /**
   * 生成处理后图片的存储键名（OSS对象键名）
   * @param {string} type - 资源类型目录。
   * @param {string} fileName - 原始文件名。
   * @param {string} [extension] - 目标扩展名。
   * @returns {string} OSS 对象键名。
   */
  generateStorageKey(type, fileName, extension) {
    if (!extension) {
      return `${type}/${fileName}`
    }

    const lastDotIndex = fileName.lastIndexOf('.')
    const fileNameWithoutExt = lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName
    return `${type}/${fileNameWithoutExt}.${extension}`
  }

  // ========== 基础文件操作实现 ==========

  /**
   * 上传文件到 OSS。
   * @param {Buffer|string} fileData - 文件 Buffer 或本地路径。
   * @param {string} ossKey - OSS 对象键名。
   * @param {{contentType?:string,cacheControl?:string,headers?:Record<string,string>,metadata?:Record<string,string>}} [options={}] - 上传选项。
   * @returns {Promise<string>} 写入后的对象键名。
   */
  async storeFile(fileData, ossKey, options = {}) {
    await this._ensureClient()
    try {
      let contentType = options.contentType
      if (!contentType) {
        contentType = getMimeTypeByMagicBytes(Buffer.isBuffer(fileData) ? fileData : ossKey)
      }

      const uploadOptions = {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': options.cacheControl || 'public, max-age=31536000',
          ...options.headers
        }
      }

      if (options.metadata) {
        Object.keys(options.metadata).forEach((metaKey) => {
          uploadOptions.headers[`x-oss-meta-${metaKey}`] = options.metadata[metaKey]
        })
      }

      if (Buffer.isBuffer(fileData)) {
        await this.client.put(ossKey, fileData, uploadOptions)
      } else if (typeof fileData === 'string') {
        const exists = await fsExtra.pathExists(fileData)
        if (!exists) {
          throw new Error(`Source file not found: ${fileData}`)
        }
        await this.client.put(ossKey, fileData, uploadOptions)
      } else {
        throw new Error('fileData must be Buffer or file path string')
      }

      return ossKey
    } catch (error) {
      this._handleOSSError(error, 'upload', { ossKey })
    }
  }

  /**
   * 删除 OSS 对象。
   * @param {string} ossKey - OSS 对象键名。
   * @returns {Promise<void>} 无返回值。
   */
  async deleteFile(ossKey) {
    await this._ensureClient()
    try {
      await this.client.delete(ossKey)
    } catch (error) {
      if (error.status === 404) {
        return
      }
      this._handleOSSError(error, 'delete', { ossKey })
    }
  }

  /**
   * 在 OSS 中移动对象（copy + delete）。
   * @param {string} sourceKey - 源对象键名。
   * @param {string} targetKey - 目标对象键名。
   * @returns {Promise<boolean>} 是否移动成功。
   */
  async moveFile(sourceKey, targetKey) {
    await this._ensureClient()
    try {
      await this.client.copy(targetKey, sourceKey)
      logger.info({
        message: `OSS文件复制成功: ${sourceKey} -> ${targetKey}`,
        details: { sourceKey, targetKey }
      })

      await this.client.delete(sourceKey)
      logger.info({ message: `OSS源文件删除成功: ${sourceKey}` })

      return true
    } catch (error) {
      this._handleOSSError(error, 'moveFile', { sourceKey, targetKey })
      return false
    }
  }

  /**
   * 检查 OSS 对象是否存在。
   * @param {string} ossKey - OSS 对象键名。
   * @returns {Promise<boolean>} 是否存在。
   */
  async fileExists(ossKey) {
    await this._ensureClient()
    try {
      await this.client.head(ossKey)
      return true
    } catch (error) {
      if (error.status === 404) {
        return false
      }
      this._handleOSSError(error, 'exists check', { ossKey })
    }
  }

  /**
   * 获取 OSS 文件数据（返回 Buffer）。
   * @param {string} ossKey - OSS 对象键名。
   * @returns {Promise<Buffer>} 文件数据。
   */
  async getFileData(ossKey) {
    return await this.getFileBuffer(ossKey)
  }

  /**
   * 获取 Multer 存储配置（OSS 使用内存模式）。
   * @param {Function} _generateFilename - 文件名生成器（未使用）。
   * @returns {import('multer').StorageEngine} Multer storage。
   */
  getMulterStorage(_generateFilename) {
    return multer.memoryStorage()
  }

  /**
   * 获取文件大小。
   * @param {string|Buffer} input - OSS 键名或 Buffer。
   * @returns {Promise<number>} 文件大小（字节）。
   */
  async getFileSize(input) {
    await this._ensureClient()
    if (Buffer.isBuffer(input)) {
      return input.length
    } else if (typeof input === 'string') {
      try {
        const result = await this.client.head(input)
        return parseInt(result.res.headers['content-length']) || 0
      } catch (error) {
        logger.error(`获取OSS文件大小失败: ${error.message}`, {
          ossKey: input,
          error: error.stack
        })
        return 1 * 1024 * 1024
      }
    }
    return 1 * 1024 * 1024
  }

  /**
   * 读取 OSS 文件内容。
   * @param {string} ossKey - OSS 对象键名。
   * @returns {Promise<Buffer>} 文件 Buffer。
   */
  async getFileBuffer(ossKey) {
    await this._ensureClient()
    try {
      const result = await this.client.get(ossKey)
      return result.content
    } catch (error) {
      this._handleOSSError(error, 'get file buffer', { ossKey })
    }
  }

  // ========== URL 生成实现 ==========

  /**
   * 生成文件访问 URL（优先签名 URL）。
   * @param {string|null} ossKey - OSS 对象键名。
   * @param {{expiresIn?:number}} [options={}] - URL 选项。
   * @returns {Promise<string|null>} 访问 URL 或 null。
   */
  async getFileUrl(ossKey, options = {}) {
    await this._ensureClient()
    if (!ossKey || typeof ossKey !== 'string' || ossKey.trim() === '') {
      logger.info({
        message: '拼接图片URL时发现ossKey为空，跳过URL生成',
        details: {
          ossKey,
          step: 'getFileUrl',
          action: 'skip_url_generation'
        }
      })
      return null
    }

    const { expiresIn = 3600 } = options

    try {
      const signedUrl = await this._getSignedUrl(ossKey, expiresIn)
      return signedUrl
    } catch (error) {
      logger.warn({
        message: 'Failed to generate signed URL, falling back to public URL',
        details: { ossKey, error: error.message }
      })
      return `${this.baseUrl}/${ossKey}`
    }
  }

  /**
   * 生成 OSS 签名下载 URL。
   * @param {string} ossKey - OSS 对象键名。
   * @param {number} [expiresIn=3600] - 过期秒数。
   * @returns {Promise<string>} 签名 URL。
   */
  async _getSignedUrl(ossKey, expiresIn = 3600) {
    await this._ensureClient()
    try {
      const signer = this.signer || this.client
      return signer.signatureUrl(ossKey, { expires: expiresIn, method: 'GET' })
    } catch (error) {
      this._handleOSSError(error, 'generate signed URL', { ossKey, expiresIn })
    }
  }

  /**
   * 获取 OSS 表单直传签名参数。
   * @param {{storageKey:string,contentType:string,contentLength:number,userId:number|string,sessionId?:string}} params - 签名参数。
   * @returns {Promise<object>} 直传签名响应。
   */
  async getUploadSignature(params) {
    return buildUploadSignature(this, params)
  }

  // ========== 批量删除 ==========

  /**
   * 批量删除 OSS 对象。
   * @param {Array<string>} keys - 对象键名列表。
   * @returns {Promise<Array<{key:string,success:boolean,error?:string}>>} 删除结果列表。
   */
  async deleteFiles(keys) {
    await this._ensureClient()
    try {
      const results = []
      const batchSize = 1000

      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize)

        try {
          const result = await this.client.deleteMulti(batch, {
            quiet: false
          })

          if (result.deleted) {
            result.deleted.forEach((obj) => {
              results.push({ key: obj.Key, success: true })
            })
          }

          if (result.failed) {
            result.failed.forEach((obj) => {
              results.push({
                key: obj.Key,
                success: false,
                error: `${obj.Code}: ${obj.Message}`
              })
            })
          }

          if (!result.deleted && !result.failed) {
            batch.forEach((key) => {
              results.push({ key, success: true })
            })
          }
        } catch (error) {
          batch.forEach((key) => {
            results.push({ key, success: false, error: error.message })
          })
        }
      }

      return results
    } catch (error) {
      this._handleOSSError(error, 'batch delete', { count: keys.length })
    }
  }
}

module.exports = AliyunOSSAdapter
