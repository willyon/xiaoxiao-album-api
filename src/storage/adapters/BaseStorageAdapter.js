/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 存储适配器基类 - 定义统一的存储操作接口
 */

class BaseStorageAdapter {
  constructor(config = {}) {
    this.config = config
    this.type = 'base'
  }

  // 说明：本类为抽象接口层，方法参数命名为 _xxx 表示“基类不直接使用”。
  // 这些参数仍然保留在签名中，用于约束子类实现的统一契约。

  // ========== 基础文件操作 ==========

  /**
   * 上传文件
   * @param {Buffer|string} fileData - 文件数据(Buffer)或文件路径(string)
   * @param {string} key - 存储键名（如: thumbnail/abc123.webp）
   * @param {Object} options - 上传选项 {contentType, metadata}
   * @returns {Promise<string>} 返回文件的访问URL或存储路径
   */
  async storeFile(_fileData, _key, _options = {}) {
    throw new Error(`storeFile method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 删除文件
   * @param {string} key - 存储键名
   * @returns {Promise<void>}
   */
  async deleteFile(_key) {
    throw new Error(`deleteFile method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 移动/重命名文件
   * 注意：此方法仅适用于支持文件移动的存储类型（如本地存储）
   * OSS等对象存储不支持此操作
   * @param {string} fromKey - 源文件键名
   * @param {string} toKey - 目标文件键名
   * @returns {Promise<void>}
   */
  async moveFile(_fromKey, _toKey) {
    throw new Error(`moveFile method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 检查文件是否存在
   * @param {string} key - 存储键名
   * @returns {Promise<boolean>}
   */
  async fileExists(_key) {
    throw new Error(`fileExists method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 获取文件内容的Buffer
   * @param {string} key - 存储键名
   * @returns {Promise<Buffer>} 文件内容的Buffer
   */
  async getFileBuffer(_key) {
    throw new Error(`getFileBuffer method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 获取文件数据
   * 本地存储：返回绝对文件路径，OSS存储：返回Buffer
   * @param {string} key - 存储键名
   * @returns {Promise<string|Buffer>} 文件路径或Buffer数据
   */
  async getFileData(_key) {
    throw new Error(`getFileData method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 获取文件大小用于优化处理
   * @param {string|Buffer} input - 输入数据，可以是存储键名或Buffer
   * @returns {Promise<number>} 文件大小（字节）
   */
  async getFileSize(_input) {
    throw new Error(`getFileSize method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 获取Multer存储配置
   * @param {Function} generateFilename - 文件名生成函数
   * @returns {Object} Multer存储配置对象
   */
  getMulterStorage(_generateFilename) {
    throw new Error(`getMulterStorage method must be implemented in ${this.constructor.name}`)
  }

  /**
   * 生成处理后图片的存储键名
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} fileName - 原始文件名
   * @param {string} [extension] - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')，不传则使用fileName本身
   * @returns {string} 存储键名
   */
  generateStorageKey(_type, _fileName, _extension) {
    throw new Error(`generateStorageKey method must be implemented in ${this.constructor.name}`)
  }

  // ========== URL 生成 ==========

  /**
   * 获取文件访问URL
   * @param {string} key - 存储键名
   * @param {Object} options - 选项参数
   * @returns {Promise<string>|string} 文件访问URL
   */
  getFileUrl(_key, _options = {}) {
    throw new Error(`getFileUrl method must be implemented in ${this.constructor.name}`)
  }

  // ========== 批量删除 ==========

  /**
   * 批量删除文件
   * @param {Array<string>} keys - 存储键名数组
   * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>}
   */
  async deleteFiles(keys) {
    const results = []
    for (const key of keys) {
      try {
        await this.deleteFile(key)
        results.push({ key, success: true })
      } catch (error) {
        results.push({ key, success: false, error: error.message })
      }
    }
    return results
  }
}

module.exports = BaseStorageAdapter
