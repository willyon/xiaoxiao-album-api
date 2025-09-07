/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 存储适配器工厂 - 根据配置创建对应的存储适配器实例
 */

const LocalStorageAdapter = require("../adapters/LocalStorageAdapter");
const AliyunOSSAdapter = require("../adapters/AliyunOSSAdapter");
const logger = require("../../utils/logger");
const { STORAGE_TYPES, OSS_AUTH_TYPES, getDefaultConfig, getSupportedStorageTypes } = require("../constants/StorageTypes");

class StorageAdapterFactory {
  static currentAdapter = null;

  /**
   * 根据传入的配置对象创建存储适配器（私有方法）
   * @private
   * @param {Object} config - 存储配置
   * @param {string} config.type - 存储类型 ('local' | 'aliyun-oss' | 'tencent-cos')
   * @param {Object} config.options - 存储选项
   * @returns {LocalStorageAdapter|AliyunOSSAdapter} 存储适配器实例
   */
  static _createAdapterFromConfig(config) {
    if (!config || !config.type) {
      throw new Error("Storage config is required with type field");
    }

    const { type, options = {} } = config;

    try {
      switch (type.toLowerCase()) {
        case STORAGE_TYPES.LOCAL:
          return new LocalStorageAdapter(options);

        case STORAGE_TYPES.ALIYUN_OSS:
          return new AliyunOSSAdapter(options);

        // 未来可扩展其他云存储
        // case 'tencent-cos':
        //   return new TencentCOSAdapter(options);
        // case 'aws-s3':
        //   return new AWSS3Adapter(options);

        default:
          throw new Error(`Unsupported storage type: ${type}. Supported types: ${getSupportedStorageTypes().join(", ")}`);
      }
    } catch (error) {
      logger.error({
        message: "Failed to create storage adapter",
        details: { type, error: error.message },
      });
      throw error;
    }
  }

  /**
   * 从环境变量读取配置并创建存储适配器
   * @param {string} [storageType] - 存储类型，如果不传则使用环境变量 STORAGE_TYPE
   * @returns {LocalStorageAdapter|AliyunOSSAdapter} 存储适配器实例
   */
  static _createAdapterFromEnv(storageType = null) {
    const defaultConfig = getDefaultConfig();
    const finalStorageType = storageType || defaultConfig.STORAGE_TYPE;

    let config = {
      type: finalStorageType,
      options: {},
    };

    switch (finalStorageType.toLowerCase()) {
      case STORAGE_TYPES.LOCAL:
        config.options = {
          baseUrl: process.env.STORAGE_LOCAL_BASE_URL,
        };
        break;

      case STORAGE_TYPES.ALIYUN_OSS:
        const authType = defaultConfig.OSS_AUTH_TYPE;

        config.options = {
          region: process.env.ALIYUN_OSS_REGION,
          bucket: process.env.ALIYUN_OSS_BUCKET,
          authType,
          customDomain: process.env.ALIYUN_OSS_CUSTOM_DOMAIN,
          timeout: parseInt(process.env.ALIYUN_OSS_TIMEOUT) || 60000,
          secure: process.env.ALIYUN_OSS_SECURE !== "false",
          uploadConcurrency: parseInt(process.env.ALIYUN_OSS_UPLOAD_CONCURRENCY) || 5,
        };

        // 根据认证方式添加相应的配置
        switch (authType.toLowerCase()) {
          case OSS_AUTH_TYPES.ACCESS_KEY:
            config.options.accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
            config.options.accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
            break;

          case OSS_AUTH_TYPES.STS:
            config.options.accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
            config.options.accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
            config.options.stsToken = process.env.ALIYUN_OSS_STS_TOKEN;
            break;

          case OSS_AUTH_TYPES.RAM:
          default:
            // RAM角色授权不需要额外配置
            break;
        }
        break;

      default:
        logger.warn({
          message: `Unknown storage type ${finalStorageType}, falling back to local storage`,
          details: { storageType: finalStorageType, supportedTypes: getSupportedStorageTypes() },
        });
        config = {
          type: STORAGE_TYPES.LOCAL,
          options: {
            baseUrl: process.env.STORAGE_LOCAL_BASE_URL,
          },
        };
    }

    return StorageAdapterFactory._createAdapterFromConfig(config);
  }

  /**
   * 创建或获取存储适配器实例
   *
   * @param {Object|string|null} [config=null] - 配置参数
   *   - 如果传入对象：使用配置对象创建适配器
   *   - 如果传入字符串：使用环境变量创建指定类型的适配器
   *   - 如果传入null：使用环境变量创建默认适配器
   * @param {boolean} [useCache=true] - 是否使用缓存，默认true
   *
   * @param {string} config.type - 存储类型，必填
   *   - 'local': 本地存储
   *   - 'aliyun-oss': 阿里云OSS存储
   *
   * @param {Object} config.options - 存储选项，根据存储类型而定
   *
   * // 本地存储选项 (type: 'local')
   * @param {string} [config.options.baseUrl] - 本地存储的基础URL，如 'http://localhost:3000'
   *
   * // 阿里云OSS存储选项 (type: 'aliyun-oss')
   * @param {string} config.options.region - OSS地域，如 'oss-cn-guangzhou'
   * @param {string} config.options.bucket - OSS存储桶名称
   * @param {string} [config.options.authType='ram'] - 认证方式: 'ram' | 'accesskey' | 'sts'
   * @param {string} [config.options.customDomain] - 自定义域名
   * @param {string} [config.options.accessKeyId] - AccessKey ID (authType为'accesskey'或'sts'时必填)
   * @param {string} [config.options.accessKeySecret] - AccessKey Secret (authType为'accesskey'或'sts'时必填)
   * @param {string} [config.options.stsToken] - STS Token (authType为'sts'时必填)
   *
   * @returns {LocalStorageAdapter|AliyunOSSAdapter} 存储适配器实例
   *
   * @example
   * // 使用环境变量配置（推荐，带缓存）
   * const adapter = StorageAdapterFactory.createAdapter();
   *
   * @example
   * // 创建指定类型的适配器（带缓存）
   * const localAdapter = StorageAdapterFactory.createAdapter('local');
   * const ossAdapter = StorageAdapterFactory.createAdapter('aliyun-oss');
   *
   * @example
   * // 创建指定类型的适配器（不使用缓存）
   * const localAdapter = StorageAdapterFactory.createAdapter('local', false);
   *
   * @example
   * // 使用配置对象创建适配器（不使用缓存）
   * const localAdapter = StorageAdapterFactory.createAdapter({
   *   type: 'local',
   *   options: { baseUrl: 'http://localhost:3000' }
   * }, false);
   */
  static createAdapter(config = null, useCache = true) {
    // 如果使用缓存且已有适配器，直接返回
    if (useCache && StorageAdapterFactory.currentAdapter) {
      return StorageAdapterFactory.currentAdapter;
    }

    let adapter;

    if (typeof config === "string") {
      // 传入字符串：创建指定类型的适配器
      adapter = StorageAdapterFactory._createAdapterFromEnv(config);
    } else if (config && typeof config === "object") {
      // 传入对象：使用配置对象创建适配器
      adapter = StorageAdapterFactory._createAdapterFromConfig(config);
    } else {
      // 传入null或undefined：使用环境变量创建默认适配器
      adapter = StorageAdapterFactory._createAdapterFromEnv();
    }

    // 如果使用缓存，保存到currentAdapter
    if (useCache) {
      StorageAdapterFactory.currentAdapter = adapter;
      logger.info({
        message: "Storage adapter initialized",
        details: {
          type: adapter.getType(),
          config: adapter.config,
        },
      });
    }

    return adapter;
  }

  /**
   * 清空当前适配器实例（用于配置变更时强制重新初始化）
   */
  static clearAdapter() {
    StorageAdapterFactory.currentAdapter = null;
    logger.info({ message: "Storage adapter cleared, will be re-initialized on next access" });
  }

  /**
   * 获取支持的存储类型列表
   * @returns {Array<string>} 支持的存储类型
   */
  static getSupportedTypes() {
    return getSupportedStorageTypes();
  }
}

module.exports = StorageAdapterFactory;
