/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 阿里云OSS存储适配器
 */

const path = require("path");
const OSS = require("ali-oss");
const fsExtra = require("fs-extra");
const multer = require("multer");
const BaseStorageAdapter = require("./BaseStorageAdapter");
const { STORAGE_TYPES } = require("../constants/StorageTypes");
const logger = require("../../utils/logger");
const { isAliyunECS } = require("../../utils/environmentDetector");

/**
 * 阿里云OSS存储适配器
 * 支持多种认证方式：RAM角色授权（推荐）、AccessKey、STS临时凭证
 *
 * @class AliyunOSSAdapter
 * @extends {BaseStorageAdapter}
 *
 * @example
 * // RAM角色授权（推荐，适用于ECS环境）
 * const ramConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "ram"
 * };
 *
 * @example
 * // AccessKey方式
 * const accessKeyConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "accesskey",
 *   accessKeyId: "your_access_key_id",
 *   accessKeySecret: "your_access_key_secret"
 * };
 *
 * @example
 * // STS临时凭证
 * const stsConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "sts",
 *   accessKeyId: "temp_access_key_id",
 *   accessKeySecret: "temp_access_key_secret",
 *   stsToken: "temp_sts_token"
 * };
 *
 * @example
 * // 使用CDN自定义域名
 * const cdnConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "ram",
 *   customDomain: "https://cdn.example.com" // 或 "cdn.example.com"
 * };
 *
 * @param {Object} config - 配置对象
 *
 * @param {string} config.region - OSS区域标识符（必需）
 *   支持的区域：
 *   - 华东：oss-cn-hangzhou, oss-cn-shanghai
 *   - 华北：oss-cn-beijing, oss-cn-qingdao, oss-cn-zhangjiakou
 *   - 华南：oss-cn-shenzhen, oss-cn-guangzhou
 *   - 海外：oss-us-west-1, oss-ap-southeast-1, oss-eu-central-1 等
 *
 * @param {string} config.bucket - OSS存储桶名称（必需）
 *
 *
 * @param {string} [config.customDomain] - 自定义访问域名（可选）
 *   - 支持CDN加速域名，如："https://cdn.example.com" 或 "cdn.example.com"
 *   - 如果不提供协议前缀，默认使用https://
 *   - 用于替代默认的OSS域名生成文件访问URL
 *
 * @param {number} [config.timeout=60000] - 请求超时时间（毫秒）
 *   - 单个OSS请求的最大等待时间
 *   - 建议：小文件30秒，大文件5-10分钟
 *
 * @param {boolean} [config.secure=true] - 是否使用HTTPS
 *   - 推荐保持true，使用HTTPS协议
 */
class AliyunOSSAdapter extends BaseStorageAdapter {
  constructor(config = {}) {
    super(config);
    this.type = STORAGE_TYPES.ALIYUN_OSS;
    this.config = config;

    // 1. 首先验证必要配置
    this._validateConfig();

    // 2. 初始化OSS客户端（baseUrl将在首次使用时初始化）
    this.client = this._createOSSClient();
  }

  /**
   * 生成处理后图片的存储键名（OSS对象键名）
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} filename - 原始文件名
   * @param {string} [extension] - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')，不传则使用filename本身
   * @returns {string} OSS对象键名
   */
  generateStorageKey(type, filename, extension) {
    // 如果没有传extension，直接使用filename本身
    if (!extension) {
      return `${type}/${filename}`;
    }

    // 传了extension，则使用原来的逻辑
    const baseName = path.basename(filename, path.extname(filename));
    return `${type}/${baseName}.${extension}`;
  }

  /**
   * 创建OSS客户端（支持RAM角色和AccessKey两种认证方式）
   * @returns {OSS} OSS客户端实例
   * @private
   */
  _createOSSClient() {
    const baseConfig = {
      region: this.config.region,
      bucket: this.config.bucket,
      timeout: this.config.timeout || 300000, // 单个请求超时时间，默认5分钟（300秒）
      secure: this.config.secure !== false, // 默认使用HTTPS
    };

    const authType = this.config.authType;

    switch (authType.toLowerCase()) {
      case "ram":
      case "role":
        // RAM角色授权方式（推荐）
        logger.info({
          message: "Initializing aliyun OSS client with RAM role authentication",
          details: { region: this.config.region, bucket: this.config.bucket },
        });

        // RAM角色认证：OSS SDK会自动从ECS实例元数据服务获取临时凭证
        // 不需要提供accessKeyId和accessKeySecret
        return new OSS({
          ...baseConfig,
          // 不设置accessKeyId和accessKeySecret，让SDK自动获取RAM角色凭证
        });

      case "accesskey":
      case "key":
        // AccessKey方式
        logger.info({
          message: "Initializing aliyun OSS client with AccessKey authentication",
          details: { region: this.config.region, bucket: this.config.bucket },
        });

        return new OSS({
          ...baseConfig,
          accessKeyId: this.config.accessKeyId,
          accessKeySecret: this.config.accessKeySecret,
        });

      case "sts":
        // STS临时凭证方式
        logger.info({
          message: "Initializing aliyun OSS client with STS token authentication",
          details: { region: this.config.region, bucket: this.config.bucket },
        });

        return new OSS({
          ...baseConfig,
          accessKeyId: this.config.accessKeyId,
          accessKeySecret: this.config.accessKeySecret,
          stsToken: this.config.stsToken,
        });

      default:
        throw new Error(`Unsupported authentication type: ${authType}. Supported types: ram, accesskey, sts`);
    }
  }

  /**
   * 智能初始化baseUrl（支持内网/外网自动选择）
   * @private
   */
  async _initializeBaseUrl() {
    // 如果有自定义域名，优先使用
    if (this.config.customDomain) {
      this.baseUrl =
        this.config.customDomain.startsWith("http://") || this.config.customDomain.startsWith("https://")
          ? this.config.customDomain
          : `https://${this.config.customDomain}`;

      logger.info({
        message: "使用自定义域名",
        details: { baseUrl: this.baseUrl },
      });
      return;
    }

    // 检测是否在阿里云ECS环境中
    const isECS = await isAliyunECS();

    if (isECS) {
      // 在ECS环境中，使用内网地址（节省流量费用，提高访问速度）
      this.baseUrl = `https://${this.config.bucket}.${this.config.region}.internal.aliyuncs.com`;
      logger.info({
        message: "检测到阿里云ECS环境，使用内网地址",
        details: {
          baseUrl: this.baseUrl,
          environment: "aliyun-ecs-internal",
        },
      });
    } else {
      // 非ECS环境，使用外网地址
      this.baseUrl = `https://${this.config.bucket}.${this.config.region}.aliyuncs.com`;
      logger.info({
        message: "使用外网地址",
        details: {
          baseUrl: this.baseUrl,
          environment: "external",
        },
      });
    }
  }

  /**
   * 验证配置参数
   * @private
   */
  _validateConfig() {
    // 基础必需字段
    const baseRequired = ["region", "bucket"];
    const missing = baseRequired.filter((key) => !this.config[key]);

    if (missing.length) {
      throw new Error(`AliyunOSS config missing required fields: ${missing.join(", ")}`);
    }

    // 根据认证方式验证相应字段
    const authType = this.config.authType || "ram";

    switch (authType.toLowerCase()) {
      case "ram":
      case "role":
        // RAM角色授权只需要region和bucket
        break;

      case "accesskey":
      case "key":
        // AccessKey方式需要accessKeyId和accessKeySecret
        const accessKeyRequired = ["accessKeyId", "accessKeySecret"];
        const accessKeyMissing = accessKeyRequired.filter((key) => !this.config[key]);
        if (accessKeyMissing.length) {
          throw new Error(`AccessKey authentication missing required fields: ${accessKeyMissing.join(", ")}`);
        }
        break;

      case "sts":
        // STS方式需要accessKeyId、accessKeySecret和stsToken
        const stsRequired = ["accessKeyId", "accessKeySecret", "stsToken"];
        const stsMissing = stsRequired.filter((key) => !this.config[key]);
        if (stsMissing.length) {
          throw new Error(`STS authentication missing required fields: ${stsMissing.join(", ")}`);
        }
        break;

      default:
        throw new Error(`Unsupported authentication type: ${authType}. Supported types: ram, accesskey, sts`);
    }
  }

  /**
   * 处理OSS错误
   * @param {Error} error - OSS错误
   * @param {string} operation - 操作名称
   * @param {Object} context - 上下文信息
   * @private
   */
  _handleOSSError(error, operation, context = {}) {
    logger.error({
      message: `AliyunOSS ${operation} failed`,
      details: {
        code: error.code,
        message: error.message,
        status: error.status,
        requestId: error.requestId,
        ...context,
      },
    });
    throw error;
  }

  // ========== 基础文件操作实现 ==========

  /**
   * 上传文件到阿里云OSS
   * @param {Buffer|string} fileData - 文件数据(Buffer)或本地文件路径(string)
   * @param {string} ossKey - OSS对象键名
   * @param {Object} options - 上传选项
   * @returns {Promise<string>} 返回文件访问URL
   */
  async storeFile(fileData, ossKey, options = {}) {
    try {
      const uploadOptions = {
        // 设置Content-Type
        headers: {
          "Content-Type": options.contentType || this._guessContentType(ossKey),
          // 设置缓存控制
          "Cache-Control": options.cacheControl || "public, max-age=31536000", // 默认公共缓存(允许任何浏览器、cdn、代理服务器存储这个文件) 1年有效期
          ...options.headers,
        },
      };

      // 如果有元数据，添加到headers中
      if (options.metadata) {
        Object.keys(options.metadata).forEach((metaKey) => {
          uploadOptions.headers[`x-oss-meta-${metaKey}`] = options.metadata[metaKey];
        });
      }

      let result;
      if (Buffer.isBuffer(fileData)) {
        // 上传Buffer数据
        result = await this.client.put(ossKey, fileData, uploadOptions);
      } else if (typeof fileData === "string") {
        // 上传本地文件
        const exists = await fsExtra.pathExists(fileData);
        if (!exists) {
          throw new Error(`Source file not found: ${fileData}`);
        }
        result = await this.client.put(ossKey, fileData, uploadOptions);
      } else {
        throw new Error("fileData must be Buffer or file path string");
      }

      // 上传成功，返回存储键（不生成URL）
      return ossKey;
    } catch (error) {
      this._handleOSSError(error, "upload", { ossKey });
    }
  }

  /**
   * 从OSS删除文件
   * @param {string} ossKey - OSS对象键名
   * @returns {Promise<void>}
   */
  async deleteFile(ossKey) {
    try {
      await this.client.delete(ossKey);
    } catch (error) {
      // 如果文件不存在，OSS会返回204状态码，不算错误
      if (error.status === 404) {
        return; // 文件不存在，认为删除成功
      }
      this._handleOSSError(error, "delete", { ossKey });
    }
  }

  /**
   * 移动OSS文件（通过复制+删除实现）
   * @param {string} sourceKey - 源OSS对象键名
   * @param {string} targetKey - 目标OSS对象键名
   * @returns {Promise<boolean>} 移动成功返回true
   */
  async moveFile(sourceKey, targetKey) {
    try {
      // OSS没有原生的move操作，需要通过copy + delete实现
      await this.client.copy(targetKey, sourceKey);
      logger.info(`OSS文件复制成功: ${sourceKey} -> ${targetKey}`);

      await this.client.delete(sourceKey);
      logger.info(`OSS源文件删除成功: ${sourceKey}`);

      return true;
    } catch (error) {
      this._handleOSSError(error, "moveFile", { sourceKey, targetKey });
      return false;
    }
  }

  /**
   * 检查OSS中文件是否存在
   * @param {string} ossKey - OSS对象键名
   * @returns {Promise<boolean>}
   */
  async fileExists(ossKey) {
    try {
      await this.client.head(ossKey);
      return true;
    } catch (error) {
      if (error.status === 404) {
        return false;
      }
      this._handleOSSError(error, "exists check", { ossKey });
    }
  }

  /**
   * 直接存储处理后的图片（OSS需要转Buffer）
   * @param {Object} pipeline - Sharp pipeline对象
   * @param {string} ossKey - OSS对象键名
   * @returns {Promise<string>} 返回文件访问URL
   */
  async storeProcessedImage(pipeline, ossKey) {
    try {
      // OSS必须先转换为Buffer再上传
      const buffer = await pipeline.toBuffer();
      return await this.storeFile(buffer, ossKey);
    } catch (error) {
      logger.error(`OSS存储处理后图片失败: ${error.message}`, {
        ossKey,
        error: error.stack,
      });
      throw error;
    }
  }

  /**
   * 获取文件数据（OSS存储返回Buffer）
   * @param {string} ossKey - OSS对象键名
   * @returns {Promise<Buffer>} 文件Buffer数据
   */
  async getFileData(ossKey) {
    return await this.getFileBuffer(ossKey);
  }

  /**
   * 获取Multer存储配置 - 内存存储
   * @param {Function} generateFilename - 文件名生成函数（OSS模式下会在中间件中使用）
   * @returns {Object} Multer memoryStorage配置
   */
  getMulterStorage(generateFilename) {
    // OSS模式使用内存存储，文件名会在upload中间件中生成
    return multer.memoryStorage();
  }

  /**
   * 获取文件大小（OSS存储）
   * @param {string|Buffer} input - 输入数据，可以是OSS键名或Buffer
   * @returns {Promise<number>} 文件大小（字节）
   */
  async getFileSize(input) {
    if (Buffer.isBuffer(input)) {
      return input.length;
    } else if (typeof input === "string") {
      try {
        // OSS键名，获取对象信息
        const result = await this.client.head(input);
        return parseInt(result.res.headers["content-length"]) || 0;
      } catch (error) {
        logger.error(`获取OSS文件大小失败: ${error.message}`, {
          ossKey: input,
          error: error.stack,
        });
        // 返回默认大小
        return 1 * 1024 * 1024; // 1MB
      }
    }
    return 1 * 1024 * 1024; // 默认1MB
  }

  /**
   * 获取OSS文件内容的Buffer
   * @param {string} ossKey - OSS对象键名
   * @returns {Promise<Buffer>} 文件内容的Buffer
   */
  async getFileBuffer(ossKey) {
    try {
      const result = await this.client.get(ossKey);
      return result.content;
    } catch (error) {
      this._handleOSSError(error, "get file buffer", { ossKey });
    }
  }

  // ========== URL 生成实现 ==========

  /**
   * 获取OSS文件访问URL
   * 自动根据存储桶权限选择公共URL或签名URL
   * @param {string|null} ossKey - OSS对象键名，如果为null或空字符串则返回null
   * @param {Object} options - 选项
   * @param {boolean} [options.forcePublic=false] - 强制使用公共URL
   * @param {number} [options.expiresIn=3600] - 签名URL过期时间（秒）
   * @returns {Promise<string|null>} 文件访问URL，如果ossKey为空则返回null
   */
  async getFileUrl(ossKey, options = {}) {
    // 如果ossKey为空，直接返回null
    if (!ossKey || typeof ossKey !== "string" || ossKey.trim() === "") {
      logger.info({
        message: "拼接图片URL时发现ossKey为空，跳过URL生成",
        details: {
          ossKey,
          step: "getFileUrl",
          action: "skip_url_generation",
        },
      });
      return null;
    }

    // 初始化 baseUrl（如果需要）
    if (!this.baseUrl) {
      await this._initializeBaseUrl();
    }

    const { forcePublic = false, expiresIn = 3600 } = options;

    // 如果强制使用公共URL，直接返回
    if (forcePublic) {
      return `${this.baseUrl}/${ossKey}`;
    }

    // 对于私有存储桶，使用签名URL
    try {
      const signedUrl = await this.getSignedUrl(ossKey, expiresIn);
      logger.info({
        message: "Generated signed URL for private bucket access",
        details: { ossKey, expiresIn },
      });
      return signedUrl;
    } catch (error) {
      // 如果签名URL生成失败，回退到公共URL
      logger.warn({
        message: "Failed to generate signed URL, falling back to public URL",
        details: { ossKey, error: error.message },
      });
      return `${this.baseUrl}/${ossKey}`;
    }
  }

  /**
   * 获取带签名的临时访问URL
   * @param {string} ossKey - OSS对象键名
   * @param {number} expiresIn - 过期时间（秒）
   * @returns {Promise<string>} 签名URL
   */
  async getSignedUrl(ossKey, expiresIn = 3600) {
    try {
      const url = this.client.signatureUrl(ossKey, {
        expires: expiresIn,
        method: "GET",
      });
      return url;
    } catch (error) {
      this._handleOSSError(error, "generate signed URL", { ossKey, expiresIn });
    }
  }

  // ========== 目录操作实现 ==========

  /**
   * OSS不需要创建目录，此方法为空实现
   * @param {string} dirPath - 目录路径
   * @returns {Promise<void>}
   */
  async ensureDirectory(dirPath) {
    // OSS是对象存储，不需要创建目录
    return Promise.resolve();
  }

  /**
   * 列出OSS中指定前缀的所有文件
   * @param {string} prefix - 文件前缀
   * @returns {Promise<Array<string>>} 文件键名数组
   */
  async listFiles(prefix) {
    try {
      const result = await this.client.list({
        prefix: prefix,
        "max-keys": 1000, // 限制返回数量，可根据需要调整
      });

      if (!result.objects) {
        return [];
      }

      return result.objects.map((obj) => obj.name);
    } catch (error) {
      this._handleOSSError(error, "list files", { prefix });
    }
  }

  // ========== 批量操作优化 ==========

  /**
   * 批量上传文件到OSS
   * @param {Array<{fileData: Buffer|string, key: string, options?: Object}>} files
   * @returns {Promise<Array<{success: boolean, key: string, url?: string, error?: string}>>}
   */
  async storeFiles(files) {
    const results = [];

    // OSS支持并发上传，但要控制并发数避免过载
    const concurrency = this.config.uploadConcurrency || 5;
    const chunks = [];

    for (let i = 0; i < files.length; i += concurrency) {
      chunks.push(files.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (file) => {
        try {
          const url = await this.storeFile(file.fileData, file.key, file.options || {});
          return { success: true, key: file.key, url };
        } catch (error) {
          return { success: false, key: file.key, error: error.message };
        }
      });

      const chunkResults = await Promise.allSettled(promises);
      chunkResults.forEach((result) => {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            key: "unknown",
            error: result.reason?.message || "Unknown error",
          });
        }
      });
    }

    return results;
  }

  /**
   * 批量删除OSS文件
   * @param {Array<string>} keys - OSS对象键名数组
   * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>}
   */
  async deleteFiles(keys) {
    try {
      // OSS支持批量删除，最多1000个对象
      const results = [];
      const batchSize = 1000;

      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);

        try {
          const result = await this.client.deleteMulti(batch, {
            quiet: false, // 返回删除结果详情
          });

          // 处理成功删除的文件
          if (result.deleted) {
            result.deleted.forEach((obj) => {
              results.push({ key: obj.Key, success: true });
            });
          }

          // 处理删除失败的文件
          if (result.failed) {
            result.failed.forEach((obj) => {
              results.push({
                key: obj.Key,
                success: false,
                error: `${obj.Code}: ${obj.Message}`,
              });
            });
          }

          // 如果没有返回详情，认为批次中所有文件都成功删除
          if (!result.deleted && !result.failed) {
            batch.forEach((key) => {
              results.push({ key, success: true });
            });
          }
        } catch (error) {
          // 批次删除失败，标记这批次中的所有文件为失败
          batch.forEach((key) => {
            results.push({ key, success: false, error: error.message });
          });
        }
      }

      return results;
    } catch (error) {
      this._handleOSSError(error, "batch delete", { count: keys.length });
    }
  }

  // ========== 工具方法 ==========

  /**
   * 根据文件扩展名猜测Content-Type
   * @param {string} ossKey - 文件键名
   * @returns {string} Content-Type
   * @private
   */
  _guessContentType(ossKey) {
    const ext = ossKey.split(".").pop()?.toLowerCase();
    const mimeTypes = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      avif: "image/avif",
      heic: "image/heic",
      heif: "image/heif",
      gif: "image/gif",
    };

    // 默认按照application/octet-stream返回 表示这个是二进制数据流
    // 当系统无法识别文件类型时，用 application/octet-stream 确保文件能正常存储和传输
    return mimeTypes[ext] || "application/octet-stream";
  }

  /**
   * 获取OSS客户端实例（用于高级操作）
   * @returns {OSS} OSS客户端
   */
  getClient() {
    return this.client;
  }

  /**
   * 获取Bucket信息
   * @returns {Promise<Object>} Bucket信息
   */
  async getBucketInfo() {
    try {
      const result = await this.client.getBucketInfo();
      return result.bucket;
    } catch (error) {
      this._handleOSSError(error, "get bucket info");
    }
  }
}

module.exports = AliyunOSSAdapter;
