/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 存储适配器工厂 - 根据配置创建对应的存储适配器实例
 */

const LocalStorageAdapter = require('../adapters/LocalStorageAdapter')
const AliyunOSSAdapter = require('../adapters/aliyun-oss-adapter')
const { STORAGE_TYPES, getStorageConfig } = require('../../constants/storageTypes')

const ADAPTER_MAP = {
  [STORAGE_TYPES.LOCAL]: LocalStorageAdapter,
  [STORAGE_TYPES.ALIYUN_OSS]: AliyunOSSAdapter
}

class StorageAdapterFactory {
  static currentAdapter = null

  /**
   * 创建或获取存储适配器实例（单例模式）
   *
   * 该方法实现了单例模式，确保整个应用中只有一个存储适配器实例。
   * 首次调用时根据环境变量创建适配器，后续调用直接返回已创建的实例。
   *
   * ## 工作流程
   * 1. 检查是否已有适配器实例，如有则直接返回
   * 2. 从环境变量读取默认配置
   * 3. 根据存储类型创建对应的适配器实例
   * 4. 缓存实例并返回
   *
   * ## 配置来源
   * - 存储类型：`STORAGE_TYPE` 环境变量
   * - OSS认证方式：`OSS_AUTH_TYPE` 环境变量
   * - 具体配置：从 `getStorageConfig()` 获取
   *
   * @returns {LocalStorageAdapter|AliyunOSSAdapter} 存储适配器实例
   *
   * @example
   * // 基本使用
   * const adapter = StorageAdapterFactory.createAdapter();
   * await adapter.storeFile(buffer, 'path/to/file.jpg');
   *
   * @example
   * // 获取文件URL
   * const adapter = StorageAdapterFactory.createAdapter();
   * const url = await adapter.getFileUrl('path/to/file.jpg');
   *
   * @throws {Error} 当环境变量配置无效或存储类型不支持时抛出错误
   *
   * @since 1.0.0
   */
  static createAdapter() {
    // 如果已有适配器，直接返回
    if (StorageAdapterFactory.currentAdapter) {
      return StorageAdapterFactory.currentAdapter
    }

    const storageConfig = getStorageConfig()
    const Adapter = ADAPTER_MAP[storageConfig.storageType]
    if (!Adapter) {
      throw new Error(`Unsupported storage type: ${storageConfig.storageType}`)
    }
    const options = storageConfig[storageConfig.storageType]

    const adapter = new Adapter(options || {})

    // 根据配置对象创建存储适配器
    StorageAdapterFactory.currentAdapter = adapter

    return adapter
  }
}

module.exports = StorageAdapterFactory
