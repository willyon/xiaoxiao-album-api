/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 统一存储服务接口 - 封装存储适配器，提供业务友好的API
 */

const StorageAdapterFactory = require("../storage/factory/StorageAdapterFactory");
const logger = require("../utils/logger");
const path = require("path");

class StorageService {
  /**
   * 创建存储服务实例
   * @param {Object|null} [config=null] - 可选配置，如果不提供则从环境变量读取
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
   * @example
   * // 使用环境变量配置（推荐）
   * const service = new StorageService();
   *
   * @example
   * // 本地存储配置
   * const service = new StorageService({
   *   type: 'local',
   *   options: {
   *     baseUrl: 'http://localhost:3000'
   *   }
   * });
   *
   * @example
   * // 阿里云OSS - RAM角色认证（推荐）
   * const service = new StorageService({
   *   type: 'aliyun-oss',
   *   options: {
   *     region: 'oss-cn-guangzhou',
   *     bucket: 'my-bucket',
   *     authType: 'ram'
   *   }
   * });
   */
  constructor(config = null) {
    this.adapter = StorageAdapterFactory.getStorageAdapter(config);
  }

  // ========== 图片存储相关方法 ==========

  /**
   * 存储文件
   * @param {Buffer|string} fileData - 文件数据(Buffer)或源文件路径(string)
   * @param {string} targetStorageKey - 存储键名 本地存储时为目标文件路径 云OSS存储时为文件键名
   * @returns {Promise<string>} 文件访问URL
   */
  async storeFile(fileData, targetStorageKey) {
    return await this.adapter.storeFile(fileData, targetStorageKey);
  }

  /**
   * 移动文件 仅支持本地磁盘存储
   * @param {string} sourceStorageKey - 源存储键名
   * @param {string} targetStorageKey - 目标存储键名
   * @returns {Promise<void>}
   */
  async moveFile(sourceStorageKey, targetStorageKey) {
    await this.adapter.moveFile(sourceStorageKey, targetStorageKey);
  }

  // ========== URL 生成方法 ==========

  /**
   * 根据存储键名生成文件访问URL
   * @param {string} storageKey - 存储键名 本地存储时为完整路径 云OSS存储时为对象键名
   * @returns {string} 完整的文件访问URL
   */
  getFileUrl(storageKey) {
    return this.adapter.getFileUrl(storageKey);
  }

  /**
   * 获取文件内容的Buffer
   * @param {string} storageKey - 存储键名 本地存储时为完整路径 云OSS存储时为对象键名
   * @returns {Promise<Buffer>} 文件内容的Buffer
   */
  async getFileBuffer(storageKey) {
    return await this.adapter.getFileBuffer(storageKey);
  }

  /**
   * 生成处理后图片的存储键名
   * @param {string} filename - 原始文件名
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} extension - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')
   * @returns {string} 存储键名
   */
  generateProcessedImageKey(type, filename, extension) {
    return this.adapter.generateProcessedImageKey(type, filename, extension);
  }

  // ========== 文件操作方法 ==========

  /**
   * 删除文件
   * @param {string} storageKey - 存储键名 本地存储时为完整路径 云OSS存储时为对象键名
   * @returns {Promise<void>}
   */
  async deleteFile(storageKey) {
    await this.adapter.deleteFile(storageKey);
  }

  /**
   * 删除多个文件
   * @param {Array<string>} storageKeys - 存储键名数组
   * @returns {Promise<Object>} 删除结果
   */
  async deleteFiles(storageKeys) {
    const results = await this.adapter.deleteFiles(storageKeys);

    return {
      success: results.every((r) => r.success),
      results: results,
      deletedCount: results.filter((r) => r.success).length,
      failedCount: results.filter((r) => !r.success).length,
    };
  }

  /**
   * 检查文件是否存在
   * @param {string} key - 文件键名
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    return await this.adapter.fileExists(key);
  }

  // ========== 批量操作方法 ==========

  /**
   * 批量存储文件
   * @param {Array<{fileData: Buffer|string, storageKey: string, options?: Object}>} files
   * @returns {Promise<Array>} 存储结果
   */
  async batchStoreFiles(files) {
    const uploadTasks = files.map((file) => ({
      fileData: file.fileData,
      key: file.storageKey,
      options: file.options || {},
    }));

    return (await this.adapter.uploadFiles) ? await this.adapter.uploadFiles(uploadTasks) : await this.adapter.storeFiles(uploadTasks);
  }

  // ========== 工具方法 ==========

  /**
   * 获取存储适配器类型
   * @returns {string} 适配器类型
   */
  getAdapterType() {
    return this.adapter.getType();
  }
}

module.exports = StorageService;
