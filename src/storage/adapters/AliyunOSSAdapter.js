/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 阿里云OSS存储适配器
 */

const OSS = require("ali-oss");
const fsExtra = require("fs-extra");
const multer = require("multer");
const BaseStorageAdapter = require("./BaseStorageAdapter");
const logger = require("../../utils/logger");
const { generatePolicySignature } = require("../../utils/ossSignature");
const { buildOSSCallbackUrl } = require("../../utils/ossCallbackUtils");
const { OSS_AUTH_TYPES } = require("../constants/StorageTypes");
const Credential = require("@alicloud/credentials").default;

/**
 * 阿里云OSS存储适配器
 *
 * 提供完整的阿里云对象存储服务(OSS)集成，支持多种认证方式、智能网络选择、
 * 前端直传、批量操作等高级功能。适用于图片存储、文件管理、CDN加速等场景。
 *
 * @class AliyunOSSAdapter
 * @extends {BaseStorageAdapter}
 *
 * ## 主要功能
 * - 🔐 **多种认证方式**：RAM角色(推荐)、AccessKey、STS临时凭证
 * - 🌐 **智能网络选择**：自动检测ECS环境，优先使用内网地址节省流量
 * - 📤 **前端直传支持**：生成签名URL，支持前端直接上传到OSS
 * - 🔄 **批量操作**：支持批量上传、删除文件
 * - 📁 **文件管理**：上传、下载、删除、移动、检查存在性
 * - 🔗 **URL生成**：支持公共URL和签名URL
 * - 🏷️ **元数据支持**：文件元数据设置和获取
 * - ⚡ **Multer集成**：与Express文件上传中间件无缝集成
 *
 * ## 认证方式对比
 * | 认证方式 | 适用场景 | 安全性 | 推荐度 |
 * |---------|---------|--------|--------|
 * | RAM角色 | ECS生产环境 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
 * | STS临时凭证 | 前端直传、第三方集成 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
 * | AccessKey | 开发测试、小规模应用 | ⭐⭐ | ⭐⭐ |
 *
 * @example
 * // 角色授权（推荐，适用于ECS环境）
 * const roleConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "ecs_ram_role",
 *   ramRoleName: "ECS-Role-OSSReadWrite" // 可选：自动探测ECS绑定的角色
 * };
 *
 * @example
 * // AccessKey方式（开发测试）
 * const accessKeyConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "accesskey",
 *   accessKeyId: "your_access_key_id",
 *   accessKeySecret: "your_access_key_secret"
 * };
 *
 * @example
 * // STS临时凭证（前端直传）
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
 * // 自定义域名配置
 * const cdnConfig = {
 *   region: "oss-cn-hangzhou",
 *   bucket: "my-bucket",
 *   authType: "ecs_ram_role",
 *   customDomain: "https://oss.bingbingcloud.com", // 或 "oss.bingbingcloud.com"
 *   preferInternal: true // 优先使用内网地址
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
 * @param {string} [config.authType="ecs_ram_role"] - 认证方式
 *   - "ecs_ram_role": RAM角色授权（推荐，适用于ECS环境）
 *   - "accesskey": AccessKey长期密钥（开发测试）
 *   - "sts": STS临时凭证（前端直传、第三方集成）
 *
 * @param {string} [config.ramRoleName] - RAM角色名称（仅role模式）
 *   - 可选：若不传会自动探测ECS绑定的角色
 *   - 例如："ECS-Role-OSSReadWrite"
 *
 * @param {string} [config.accessKeyId] - AccessKey ID（accesskey/sts模式必需）
 * @param {string} [config.accessKeySecret] - AccessKey Secret（accesskey/sts模式必需）
 * @param {string} [config.stsToken] - STS临时凭证Token（sts模式必需）
 *
 * @param {string} [config.customDomain] - 自定义访问域名（可选）
 *   - 支持CDN加速域名，如："https://cdn.example.com" 或 "cdn.example.com"
 *   - 如果不提供协议前缀，默认使用https://
 *   - 用于替代默认的OSS域名生成文件访问URL
 *
 * @param {boolean} [config.preferInternal=false] - 是否优先使用内网地址
 *   - true: 强制使用内网地址（节省流量费用）
 *   - false: 使用公网地址（默认）
 *
 * @param {number} [config.timeout=300000] - 请求超时时间（毫秒）
 *   - 单个OSS请求的最大等待时间
 *   - 建议：小文件30秒，大文件5-10分钟
 *
 * @throws {Error} 当配置参数无效时抛出错误
 *
 * @since 1.0.0
 * @version 2.0.0
 */
class AliyunOSSAdapter extends BaseStorageAdapter {
  constructor(config = {}) {
    super(config);
    this.type = config.storageType;
    this.config = config[config.ossAuthType];

    // 异步初始化：构造后立即启动初始化流程
    this._initPromise = this._initClient();
  }

  /**
   * 异步初始化客户端
   * @private
   */
  async _initClient() {
    // 认证上下文
    const authCtx = this._prepareAuthContext();

    // 基础配置
    const baseConfig = this._buildBaseConfig();

    // 实例化客户端（可能需要异步获取 STS）
    this.client = await this._createClientByAuthType(baseConfig, authCtx);

    // 若配置了自定义域名，则在初始化阶段就创建签名用的客户端
    await this._maybeInitSigner(authCtx);

    logger.info({
      message: "阿里云OSS已连接(异步初始化)",
      details: { region: this.region, bucket: this.bucket, endpoint: baseConfig.endpoint || "(public by region)", authType: authCtx.mode },
    });
  }

  /**
   * 在初始化阶段创建“签名客户端”，用于生成以自定义域名或公网桶域名为 Host 的签名 URL
   * 触发条件：有 customDomain 或 preferInternal=true（后者用于内网 client 下的对外签名）
   * @private
   */
  async _maybeInitSigner(authCtx) {
    // 如果没有endpoint 则直接返回 代表了没有自定义域名 以及client实例没有走内网 走了默认的公网
    if (!this.config.customDomain && !this.config.preferInternal) return;
    let configObj = {};
    if (!!this.config.customDomain) {
      // 自定义域名，必须 cname:true
      configObj.endpoint = this.config.customDomain.startsWith("http")
        ? this.config.customDomain.replace(/\/+$/, "")
        : `https://${this.config.customDomain}`;
      configObj.cname = true;
    }

    const baseConfig = { region: this.region, bucket: this.bucket, ...configObj };

    if (authCtx.mode === OSS_AUTH_TYPES.ROLE) {
      // 复用主 client 的 RAM 角色凭证提供器
      const credClient = this.credential; // 已在 _createClientByAuthType 中赋值
      const s = await credClient.getCredential();

      this.signer = new OSS({
        ...baseConfig,
        accessKeyId: s.accessKeyId,
        accessKeySecret: s.accessKeySecret,
        stsToken: s.securityToken,
        refreshSTSToken: async () => {
          const r = await credClient.getCredential();
          return {
            accessKeyId: r.accessKeyId,
            accessKeySecret: r.accessKeySecret,
            stsToken: r.securityToken,
          };
        },
        refreshSTSTokenInterval: 10 * 60 * 1000, // 可按需调整
      });
      return;
    } else if (authCtx.mode === OSS_AUTH_TYPES.ACCESS_KEY) {
      this.signer = new OSS({
        ...baseConfig,
        accessKeyId: authCtx.accessKeyId,
        accessKeySecret: authCtx.accessKeySecret,
      });
      return;
    } else if (authCtx.mode === OSS_AUTH_TYPES.STS) {
      this.signer = new OSS({
        ...baseConfig,
        accessKeyId: authCtx.accessKeyId,
        accessKeySecret: authCtx.accessKeySecret,
        stsToken: authCtx.stsToken,
      });
      return;
    }
  }

  /**
   * 确保 OSS 客户端已初始化
   * @private
   */
  async _ensureClient() {
    if (!this.client) {
      // 没有正在进行的初始化就开一个
      if (!this._initPromise) this._initPromise = this._initClient();

      try {
        await this._initPromise;
      } catch (e) {
        // 让后续有机会重新触发初始化
        this._initPromise = null;
        throw e;
      }
    }
  }

  /**
   * 同步构建基础配置
   * @private
   */
  _buildBaseConfig() {
    const baseConfig = {
      region: this.region,
      bucket: this.bucket,
      timeout: this.config.timeout || 300000,
    };

    // baseUrl 仅用于拼公共 URL 的显示域名；签名 URL 由 signer 决定 Host
    this.baseUrl = this.config.customDomain || this._getBucketPublicHost();

    // 配置 preferInternal=true 时，按约定拼装内网域名（要求同地域）
    if (this.config.preferInternal) {
      baseConfig.internal = true;
      return baseConfig;
    }

    // 默认：不设置 endpoint，默认走公网
    return baseConfig;
  }

  /**
   * 校验并准备认证上下文
   * @private
   */
  _prepareAuthContext() {
    const required = ["region", "bucket"];
    const missing = required.filter((k) => !this.config[k]);
    if (missing.length) throw new Error(`AliyunOSS config missing required fields: ${missing.join(", ")}`);
    // 设置 bucket 和 region 属性
    this.bucket = this.config.bucket;
    this.region = this.config.region;

    const mode = (this?.config?.authType || OSS_AUTH_TYPES.ROLE).toLowerCase();

    if (mode === OSS_AUTH_TYPES.ACCESS_KEY) {
      const need = ["accessKeyId", "accessKeySecret"];
      const lack = need.filter((k) => !this.config[k]);
      if (lack.length) throw new Error(`AccessKey authentication missing required fields: ${lack.join(", ")}`);
      this.accessKeyId = this.config.accessKeyId;
      this.accessKeySecret = this.config.accessKeySecret;
      return { mode, accessKeyId: this.accessKeyId, accessKeySecret: this.accessKeySecret };
    } else if (mode === OSS_AUTH_TYPES.STS) {
      const need = ["accessKeyId", "accessKeySecret", "stsToken"];
      const lack = need.filter((k) => !this.config[k]);
      if (lack.length) throw new Error(`STS authentication missing required fields: ${lack.join(", ")}`);
      this.accessKeyId = this.config.accessKeyId;
      this.accessKeySecret = this.config.accessKeySecret;
      this.stsToken = this.config.stsToken;
      return { mode, accessKeyId: this.accessKeyId, accessKeySecret: this.accessKeySecret, stsToken: this.stsToken };
    }

    return { mode: OSS_AUTH_TYPES.ROLE };
  }

  /**
   * 按认证方式创建 OSS 客户端
   * @private
   */
  async _createClientByAuthType(baseConfig, authCtx) {
    const mode = authCtx.mode;

    if (mode === OSS_AUTH_TYPES.ROLE) {
      // 使用 ECS RAM 角色：先取 STS，再把三元组交给 ali-oss，并配置自动续期
      const credClient =
        this.credential ||
        new Credential({
          type: this.config.authType, // 应为 'ecs_ram_role'
          roleName: this.config.ramRoleName, // 可选
          disableIMDSv1: true,
          timeout: 3000,
        });

      const s = await credClient.getCredential();

      const client = new OSS({
        ...baseConfig,
        accessKeyId: s.accessKeyId,
        accessKeySecret: s.accessKeySecret,
        stsToken: s.securityToken,
        refreshSTSToken: async () => {
          const r = await credClient.getCredential();
          return {
            accessKeyId: r.accessKeyId,
            accessKeySecret: r.accessKeySecret,
            stsToken: r.securityToken,
          };
        },
        // 每 10 分钟刷新一次（可按需调整）
        refreshSTSTokenInterval: 10 * 60 * 1000,
      });

      this.credential = credClient;
      return client;
    } else if (mode === OSS_AUTH_TYPES.ACCESS_KEY) {
      // 长期 AK 明文传入（开发/测试）
      return new OSS({
        ...baseConfig,
        accessKeyId: authCtx.accessKeyId,
        accessKeySecret: authCtx.accessKeySecret,
      });
    } else if (mode === OSS_AUTH_TYPES.STS) {
      // 显式 STS：调用方提供的临时凭证
      return new OSS({
        ...baseConfig,
        accessKeyId: authCtx.accessKeyId,
        accessKeySecret: authCtx.accessKeySecret,
        stsToken: authCtx.stsToken,
      });
    }

    throw new Error(
      `Unsupported authentication type: ${mode}. Supported types: ${OSS_AUTH_TYPES.ROLE}, ${OSS_AUTH_TYPES.ACCESS_KEY}, ${OSS_AUTH_TYPES.STS}`,
    );
  }

  /**
   * 生成处理后图片的存储键名（OSS对象键名）
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} fileName - 原始文件名
   * @param {string} [extension] - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')，不传则使用fileName本身
   * @returns {string} OSS对象键名
   */
  generateStorageKey(type, fileName, extension) {
    // 如果没有传extension，直接使用fileName本身
    if (!extension) {
      return `${type}/${fileName}`;
    }

    // 传了extension，保持路径结构，只替换文件扩展名
    const lastDotIndex = fileName.lastIndexOf(".");
    const fileNameWithoutExt = lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName;
    return `${type}/${fileNameWithoutExt}.${extension}`;
  }

  /**
   * 获取直传表单应提交的目标 Host（总是使用 OSS 官方桶域名）
   * @returns {string}
   * @private
   */
  _getBucketPublicHost() {
    return `https://${this.bucket}.${this.region}.aliyuncs.com`;
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
    await this._ensureClient();
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

      if (Buffer.isBuffer(fileData)) {
        // 上传Buffer数据
        await this.client.put(ossKey, fileData, uploadOptions);
      } else if (typeof fileData === "string") {
        // 上传本地文件
        const exists = await fsExtra.pathExists(fileData);
        if (!exists) {
          throw new Error(`Source file not found: ${fileData}`);
        }
        await this.client.put(ossKey, fileData, uploadOptions);
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
    await this._ensureClient();
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
    await this._ensureClient();
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
    await this._ensureClient();
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
    await this._ensureClient();
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
    await this._ensureClient();
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
    await this._ensureClient();
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
   * @param {number} [options.expiresIn=3600] - 签名URL过期时间（秒）
   * @returns {Promise<string|null>} 文件访问URL，如果ossKey为空则返回null
   */
  async getFileUrl(ossKey, options = {}) {
    await this._ensureClient();
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

    const { expiresIn = 3600 } = options;

    // 对于私有存储桶，使用签名URL
    try {
      const signedUrl = await this._getSignedUrl(ossKey, expiresIn);
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
  async _getSignedUrl(ossKey, expiresIn = 3600) {
    await this._ensureClient();
    try {
      const signer = this.signer || this.client; // 有自定义域名则优先用 signer
      return signer.signatureUrl(ossKey, { expires: expiresIn, method: "GET" });
    } catch (error) {
      this._handleOSSError(error, "generate signed URL", { ossKey, expiresIn });
    }
  }

  /**
   * 获取OSS上传签名（用于直传）
   *
   * 签名过程说明：
   * 1. 构建上传策略（policy），包含上传条件、过期时间、回调信息等
   * 2. 将策略转换为Base64编码的字符串
   * 3. 使用AccessKeySecret作为密钥，对策略字符串进行HMAC-SHA1签名
   * 4. 将签名结果进行Base64编码
   * 5. 返回包含签名、策略、回调URL等信息的对象
   *
   * 注意：在RAM模式下，需要先获取STS临时凭证来生成签名
   *
   * @param {Object} options - 签名选项
   * @param {string} options.storageKey - OSS存储键
   * @param {string} options.contentType - 内容类型
   * @param {number} options.contentLength - 内容长度
   * @param {string} options.userId - 用户ID
   * @returns {Promise<Object>} 上传签名信息
   */
  async getUploadSignature({ storageKey, contentType, contentLength, userId }) {
    try {
      // 生成回调URL
      const callbackUrl = buildOSSCallbackUrl();

      // 生成回调参数 - JSON格式
      const callbackBody = JSON.stringify({
        userId,
        storageKey,
        fileSize: contentLength,
        imageHash: storageKey.split("/").pop().split(".")[0],
      });

      // 记录回调参数详情
      logger.info({
        message: "OSS回调参数详情",
        details: {
          callbackUrl,
          callbackBody,
        },
      });

      // 生成上传策略
      const policy = {
        expiration: new Date(Date.now() + 3600 * 1000).toISOString(), // 1小时后过期
        conditions: [
          ["content-length-range", 0, contentLength],
          ["eq", "$bucket", this.bucket],
          ["eq", "$key", storageKey],
          ["eq", "$Content-Type", contentType],
        ],
      };

      const policyString = Buffer.from(JSON.stringify(policy)).toString("base64");

      let signature, accessKeyId, securityToken;

      const mode = (this.config.authType || OSS_AUTH_TYPES.ROLE).toLowerCase();
      if (mode === OSS_AUTH_TYPES.ROLE) {
        const sts = await this.credential.getCredential();
        accessKeyId = sts.accessKeyId;
        securityToken = sts.securityToken;
        const accessKeySecret = sts.accessKeySecret;
        signature = generatePolicySignature(policyString, accessKeySecret);

        logger.info({
          message: "使用 ECS 角色 STS 临时凭证生成签名",
          details: {
            accessKeyId: accessKeyId ? accessKeyId.substring(0, 8) + "..." : undefined,
            expiresAt: sts.expiration,
          },
        });
      } else if (mode === OSS_AUTH_TYPES.STS) {
        // 显式 STS：使用传入的临时凭证
        accessKeyId = this.accessKeyId;
        securityToken = this.config.stsToken;
        signature = generatePolicySignature(policyString, this.accessKeySecret);
      } else {
        // AccessKey：长期密钥（无 securityToken）
        accessKeyId = this.accessKeyId;
        signature = generatePolicySignature(policyString, this.accessKeySecret);
      }

      // 构建OSS回调参数
      const callbackParam = {
        callbackUrl: callbackUrl,
        callbackBody: callbackBody,
        callbackBodyType: "application/json",
      };

      const callbackBase64 = Buffer.from(JSON.stringify(callbackParam)).toString("base64");

      const resp = {
        storageKey,
        policy: policyString,
        signature,
        accessKeyId, // 固定字段名
        successActionStatus: "200",
        contentType, // 在 policy 里做了 eq 限制，表单必须带
        callback: callbackBase64,
        host: this._getBucketPublicHost(), // 直传建议走官方桶域名
      };
      if (securityToken) {
        resp.securityToken = securityToken;
      }
      return resp;
    } catch (error) {
      logger.error({
        message: "Failed to generate upload signature",
        details: { storageKey, contentType, contentLength, userId, error: error.message },
      });
      throw error;
    }
  }

  // ========== 目录操作实现 ==========

  /**
   * 列出OSS中指定前缀的所有文件
   * @param {string} prefix - 文件前缀
   * @returns {Promise<Array<string>>} 文件键名数组
   */
  async listFiles(prefix) {
    await this._ensureClient();
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
    await this._ensureClient();
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
    await this._ensureClient();
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
}

module.exports = AliyunOSSAdapter;
