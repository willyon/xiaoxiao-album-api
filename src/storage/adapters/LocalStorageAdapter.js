/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 本地文件系统存储适配器
 */

const path = require("path");
const fsExtra = require("fs-extra");
const BaseStorageAdapter = require("./BaseStorageAdapter");
const logger = require("../../utils/logger");

class LocalStorageAdapter extends BaseStorageAdapter {
  constructor(config = {}) {
    super(config);
    this.type = "local";

    // 设置默认的 baseUrl，优先使用配置，其次使用环境变量，最后使用默认值
    // 默认端口使用常见的开发端口，可通过环境变量 PORT 动态调整
    const defaultPort = process.env.PORT || 3000;
    this.baseUrl = config.baseUrl || process.env.STORAGE_LOCAL_BASE_URL || `http://localhost:${defaultPort}`;

    // 设置基础目录为项目根目录
    this.baseDir = path.join(__dirname, "..", "..", "..");
  }

  /**
   * 获取完整的文件系统路径
   * @param {string} key - 存储键名
   * @returns {string} 完整路径
   * @private
   */
  _getFullPath(key) {
    return path.join(this.baseDir, key);
  }

  /**
   * 生成处理后图片的存储键名
   * @param {string} filename - 原始文件名
   * @param {string} type - 图片类型 ('thumbnail', 'highres', 'original')
   * @param {string} extension - 图片格式扩展名 (如: 'webp', 'avif', 'jpg')
   * @returns {string} 存储键名
   */
  generateProcessedImageKey(type, filename, extension = "webp") {
    const baseName = path.basename(filename, path.extname(filename));

    switch (type) {
      case "thumbnail":
        const thumbnailDir = process.env.PROCESSED_THUMBNAIL_IMAGE_DIR || "localStorage/processed/thumbnails";
        return `${thumbnailDir}/${baseName}.${extension}`;
      case "highres":
        const highresDir = process.env.PROCESSED_HIGH_RES_IMAGE_DIR || "localStorage/processed/highres";
        return `${highresDir}/${baseName}.${extension}`;
      case "original":
        const originalDir = process.env.PROCESSED_ORIGINAL_IMAGE_DIR || "localStorage/processed/originals";
        return `${originalDir}/${baseName}.${extension}`;
      default:
        throw new Error(`Unknown image type: ${type}`);
    }
  }

  // ========== 基础文件操作实现 ==========

  /**
   * 上传文件到本地存储
   * @param {Buffer|string} fileData - 文件数据(Buffer)或源文件路径(string)
   * @param {string} targetPath - 目标文件路径（如: localStorage/processed/highres/user123-20250829-143022-photo.png）
   * @returns {Promise<string>} 返回文件访问URL
   */
  async storeFile(fileData, targetPath) {
    try {
      const fullPath = this._getFullPath(targetPath);

      // 确保目标目录存在 path.dirname返回文件路径的目录部分
      await fsExtra.ensureDir(path.dirname(fullPath));

      if (Buffer.isBuffer(fileData)) {
        // 如果是Buffer，直接写入
        await fsExtra.writeFile(fullPath, fileData);
      } else if (typeof fileData === "string") {
        // 如果是文件路径，复制文件
        await fsExtra.copy(fileData, fullPath, { overwrite: true });
      } else {
        throw new Error("fileData must be Buffer or file path string");
      }

      return this.getFileUrl(fullPath);
    } catch (error) {
      logger.error({
        message: "Local storage upload failed",
        details: { targetPath, error: error.message },
      });
      throw error;
    }
  }

  /**
   * 删除本地文件
   * @param {string} key - 存储键名
   * @returns {Promise<void>}
   */
  async deleteFile(key) {
    try {
      const fullPath = this._getFullPath(key);
      await fsExtra.remove(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        // 文件不存在，认为删除成功
        return;
      }
      logger.error({
        message: "Local storage delete failed",
        details: { key, error: error.message },
      });
      throw error;
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
      const fromPath = this._getFullPath(fromKey);
      const toPath = this._getFullPath(toKey);

      // 确保目标目录存在
      await fsExtra.ensureDir(path.dirname(toPath));

      await fsExtra.move(fromPath, toPath, { overwrite: true });
    } catch (error) {
      logger.error({
        message: "Local storage move failed",
        details: { fromKey, toKey, error: error.message },
      });
      throw error;
    }
  }

  /**
   * 检查本地文件是否存在
   * @param {string} key - 存储键名
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    try {
      const fullPath = this._getFullPath(key);
      return await fsExtra.pathExists(fullPath);
    } catch (error) {
      logger.error({
        message: "Local storage exists check failed",
        details: { key, error: error.message },
      });
      return false;
    }
  }

  /**
   * 获取本地文件内容的Buffer
   * @param {string} key - 存储键名
   * @returns {Promise<Buffer>} 文件内容的Buffer
   */
  async getFileBuffer(key) {
    try {
      const fullPath = this._getFullPath(key);
      return await fsExtra.readFile(fullPath);
    } catch (error) {
      logger.error({
        message: "Local storage read file failed",
        details: { key, fullPath: this._getFullPath(key), error: error.message },
      });
      throw error;
    }
  }

  // ========== URL 生成实现 ==========

  /**
   * 获取本地文件访问URL
   * @param {string} key - 存储键名
   * @param {string} type - 文件类型（本地存储忽略此参数）
   * @returns {string} 文件访问URL
   */
  getFileUrl(fullPath) {
    // 本地存储直接返回相对URL
    return `${this.baseUrl}/${fullPath}`;
  }

  // ========== 目录操作实现 ==========

  /**
   * 确保本地目录存在
   * @param {string} dirPath - 目录路径（相对于baseDir）
   * @returns {Promise<void>}
   */
  async ensureDirectory(dirPath) {
    try {
      const fullDirPath = this._getFullPath(dirPath);
      await fsExtra.ensureDir(fullDirPath);
    } catch (error) {
      logger.error({
        message: "Local storage ensure directory failed",
        details: { dirPath, error: error.message },
      });
      throw error;
    }
  }

  /**
   * 列出本地指定前缀的所有文件
   * @param {string} prefix - 文件前缀
   * @returns {Promise<Array<string>>} 文件键名数组
   */
  async listFiles(prefix) {
    try {
      const prefixPath = this._getFullPath(prefix);
      const exists = await fsExtra.pathExists(prefixPath);

      if (!exists) {
        return [];
      }

      const stat = await fsExtra.stat(prefixPath);
      if (stat.isFile()) {
        return [prefix];
      }

      // 如果是目录，递归读取所有文件
      const files = [];
      const items = await fsExtra.readdir(prefixPath);

      for (const item of items) {
        const itemPath = path.join(prefixPath, item);
        const itemStat = await fsExtra.stat(itemPath);
        const itemKey = path.join(prefix, item);

        if (itemStat.isFile()) {
          files.push(itemKey);
        } else if (itemStat.isDirectory()) {
          const subFiles = await this.listFiles(itemKey);
          files.push(...subFiles);
        }
      }

      return files;
    } catch (error) {
      logger.error({
        message: "Local storage list files failed",
        details: { prefix, error: error.message },
      });
      throw error;
    }
  }

  // ========== 批量操作优化 ==========

  /**
   * 批量上传文件（本地存储优化版本）
   * @param {Array<{fileData: Buffer|string, key: string, options?: Object}>} files
   * @returns {Promise<Array<{success: boolean, key: string, url?: string, error?: string}>>}
   */
  async storeFiles(files) {
    const results = [];

    // 并行处理提高效率
    const promises = files.map(async (file) => {
      try {
        const url = await this.storeFile(file.fileData, file.key, file.options || {});
        return { success: true, key: file.key, url };
      } catch (error) {
        return { success: false, key: file.key, error: error.message };
      }
    });

    const settled = await Promise.allSettled(promises);

    settled.forEach((result) => {
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

    return results;
  }

  /**
   * 批量删除文件（本地存储优化版本）
   * @param {Array<string>} keys - 存储键名数组
   * @returns {Promise<Array<{key: string, success: boolean, error?: string}>>}
   */
  async deleteFiles(keys) {
    const results = [];

    // 并行处理提高效率
    const promises = keys.map(async (key) => {
      try {
        await this.deleteFile(key);
        return { key, success: true };
      } catch (error) {
        return { key, success: false, error: error.message };
      }
    });

    const settled = await Promise.allSettled(promises);

    settled.forEach((result) => {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          key: "unknown",
          success: false,
          error: result.reason?.message || "Unknown error",
        });
      }
    });

    return results;
  }
}

module.exports = LocalStorageAdapter;
