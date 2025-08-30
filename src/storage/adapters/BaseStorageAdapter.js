/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 存储适配器基类 - 定义统一的存储操作接口
 */

class BaseStorageAdapter {
  constructor(config = {}) {
    this.config = config;
    this.type = "base";
  }

  // ========== 基础文件操作 ==========

  /**
   * 上传文件
   * @param {Buffer|string} fileData - 文件数据(Buffer)或文件路径(string)
   * @param {string} key - 存储键名（如: thumbnails/abc123.webp）
   * @param {Object} options - 上传选项 {contentType, metadata}
   * @returns {Promise<string>} 返回文件的访问URL或存储路径
   */
  async storeFile(fileData, key, options = {}) {
    throw new Error(`storeFile method must be implemented in ${this.constructor.name}`);
  }

  /**
   * 删除文件
   * @param {string} key - 存储键名
   * @returns {Promise<void>}
   */
  async deleteFile(key) {
    throw new Error(`deleteFile method must be implemented in ${this.constructor.name}`);
  }

  /**
   * 移动/重命名文件
   * 注意：此方法仅适用于支持文件移动的存储类型（如本地存储）
   * OSS等对象存储不支持此操作
   * @param {string} fromKey - 源文件键名
   * @param {string} toKey - 目标文件键名
   * @returns {Promise<void>}
   */
  async moveFile(fromKey, toKey) {
    throw new Error(`moveFile method must be implemented in ${this.constructor.name}`);
  }

  /**
   * 检查文件是否存在
   * @param {string} key - 存储键名
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    throw new Error(`fileExists method must be implemented in ${this.constructor.name}`);
  }

  /**
   * 获取文件内容的Buffer
   * @param {string} key - 存储键名
   * @returns {Promise<Buffer>} 文件内容的Buffer
   */
  async getFileBuffer(key) {
    throw new Error(`getFileBuffer method must be implemented in ${this.constructor.name}`);
  }

  /**
   * 生成处理后图片的存储键名
   * @param {string} filename - 原始文件名
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} extension - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')
   * @returns {string} 存储键名
   */
  generateProcessedImageKey(type, filename, extension) {
    throw new Error(`generateProcessedImageKey method must be implemented in ${this.constructor.name}`);
  }

  // ========== URL 生成 ==========

  /**
   * 获取文件访问URL
   * @param {string} key - 存储键名
   * @param {string} type - 文件类型 ('thumbnail' | 'highres' | 'original')
   * @returns {string} 文件访问URL
   */
  getFileUrl(key, type = "thumbnail") {
    throw new Error(`getFileUrl method must be implemented in ${this.constructor.name}`);
  }

  /**
   * 获取带签名的临时访问URL（用于私有文件）
   * @param {string} key - 存储键名
   * @param {number} expiresIn - 过期时间（秒）
   * @returns {Promise<string>} 签名URL
   */
  async getSignedUrl(key, expiresIn = 3600) {
    // 默认返回普通URL，子类可以覆盖实现签名逻辑
    return this.getFileUrl(key);
  }

  // ========== 批量操作 ==========

  /**
   * 批量上传文件
   * @param {Array<{fileData: Buffer|string, key: string, options?: Object}>} files
   * @returns {Promise<Array<string>>} 返回所有文件的URL数组
   */
  async storeFiles(files) {
    const results = [];
    for (const file of files) {
      try {
        const url = await this.storeFile(file.fileData, file.key, file.options || {});
        results.push({ success: true, key: file.key, url });
      } catch (error) {
        results.push({ success: false, key: file.key, error: error.message });
      }
    }
    return results;
  }

  /**
   * 批量删除文件
   * @param {Array<string>} keys - 存储键名数组
   * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>}
   */
  async deleteFiles(keys) {
    const results = [];
    for (const key of keys) {
      try {
        await this.deleteFile(key);
        results.push({ key, success: true });
      } catch (error) {
        results.push({ key, success: false, error: error.message });
      }
    }
    return results;
  }

  // ========== 目录操作 ==========

  /**
   * 确保目录存在（本地存储需要，云存储可能不需要）
   * @param {string} dirPath - 目录路径
   * @returns {Promise<void>}
   */
  async ensureDirectory(dirPath) {
    // 默认实现：什么都不做（云存储通常不需要创建目录）
    return Promise.resolve();
  }

  /**
   * 列出指定前缀的所有文件
   * @param {string} prefix - 文件前缀
   * @returns {Promise<Array<string>>} 文件键名数组
   */
  async listFiles(prefix) {
    throw new Error(`listFiles method must be implemented in ${this.constructor.name}`);
  }

  // ========== 工具方法 ==========

  /**
   * 从键名中提取文件名
   * @param {string} key - 存储键名
   * @returns {string} 文件名
   */
  extractFilename(key) {
    return key.split("/").pop();
  }

  /**
   * 获取适配器类型
   * @returns {string} 适配器类型
   */
  getType() {
    return this.type;
  }
}

module.exports = BaseStorageAdapter;
