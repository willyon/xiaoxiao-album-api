/*
 * @Author: zhangshouchang
 * @Date: 2025-08-29
 * @Description: 统一存储服务 - 提供统一的文件存储接口，支持本地存储和云存储
 */

const StorageAdapterFactory = require("../storage/factory/StorageAdapterFactory");
const { STORAGE_TYPES } = require("../storage/constants/StorageTypes");
const logger = require("../utils/logger");
const sharp = require("sharp");

// Sharp 预设配置
const SHARP_CONFIG = {
  failOnError: false, // 避免遇到坏图直接崩
  sequentialRead: true, // 顺序读取，减少磁盘随机 I/O
  limitInputPixels: false, // 不限制像素避免超大图被强制拒绝（如需要可设上限）
  // 性能优化配置
  density: 72, // 设置DPI(像素密度) 降低内存占用 提升处理速度 72位标准屏dpi 对web显示来说 72dpi就够了 对最终图片质量影响很小
};

// 文件大小阈值
const FILE_SIZE_THRESHOLDS = {
  SMALL: 1 * 1024 * 1024, // 1MB
  MEDIUM: 5 * 1024 * 1024, // 5MB
  LARGE: 10 * 1024 * 1024, // 10MB
};

/**
 * 获取自适应质量参数
 * @param {number} quality - 基础质量
 * @param {number} fileSize - 文件大小
 * @returns {number} 调整后的质量参数
 */
function _getAdaptiveQuality(quality, fileSize) {
  // 根据文件大小调整质量
  if (fileSize >= FILE_SIZE_THRESHOLDS.LARGE) {
    return Math.max(quality - 5, 50); // 大文件降低质量
  } else if (fileSize >= FILE_SIZE_THRESHOLDS.MEDIUM) {
    return Math.max(quality - 5, 50); // 中等文件稍微降低质量
  } else if (fileSize <= FILE_SIZE_THRESHOLDS.SMALL) {
    return Math.min(quality + 5, 95); // 小文件可以提高质量
  }

  return quality;
}

/**
 * 获取最优effort参数
 * @param {number} fileSize - 文件大小
 * @param {string} format - 目标格式
 * @returns {number} effort参数 (0-6)
 */
function _getOptimalEffort(fileSize, format) {
  // 正确的逻辑：大文件用高effort（时间换空间），小文件用低effort（速度优先）
  if (format === "avif") {
    // AVIF格式压缩效率高，effort影响明显
    if (fileSize >= FILE_SIZE_THRESHOLDS.LARGE) {
      return 6; // 大文件用最高effort，压缩收益最大
    } else if (fileSize >= FILE_SIZE_THRESHOLDS.MEDIUM) {
      return 4; // 中等文件平衡处理
    }
    return 2; // 小文件快速处理，避免浪费时间
  } else if (format === "webp") {
    // WebP格式effort影响相对较小，但仍遵循同样原则
    if (fileSize >= FILE_SIZE_THRESHOLDS.LARGE) {
      return 5; // 大文件高effort，优化存储
    } else if (fileSize >= FILE_SIZE_THRESHOLDS.MEDIUM) {
      return 4; // 中等文件适度优化
    }
    return 3; // 小文件适中effort
  }

  return 3; // 默认effort
}

/**
 * 根据扩展名应用相应的编码器
 * @param {Object} pipeline - Sharp pipeline对象
 * @param {string} ext - 文件扩展名
 * @param {number} quality - 图片质量 (1-100)
 * @param {number} fileSize - 文件大小（字节）
 * @param {Object} options - 优化选项
 * @returns {Object} 配置好的pipeline
 */
function _applyEncoderByExt(pipeline, ext, quality = 80, fileSize = FILE_SIZE_THRESHOLDS.MEDIUM, options = {}) {
  const { enableAdaptiveQuality, enableDynamicEffort } = options;

  // 获取自适应质量和effort
  const adaptiveQuality = enableAdaptiveQuality ? _getAdaptiveQuality(quality, fileSize) : quality;
  const optimalEffort = enableDynamicEffort ? _getOptimalEffort(fileSize, ext) : 1;
  switch (ext) {
    case "jpg":
    case "jpeg":
      return pipeline.jpeg({
        quality: adaptiveQuality,
        mozjpeg: true, // 使用 mozjpeg 优化器，体积更小
        chromaSubsampling: "4:2:0", // 色度抽样，压缩更好（人眼对色敏感度低于亮度）
        trellisQuantisation: true, // 网格量化，进一步优化率失真
        overshootDeringing: true, // 去振铃伪影，边缘更干净
      });
    case "png":
      // PNG压缩级别根据文件大小调整
      const compressionLevel = fileSize >= FILE_SIZE_THRESHOLDS.LARGE ? 9 : 6;
      return pipeline.png({
        compressionLevel,
        palette: true, // 尝试索引色调色板
        adaptiveFiltering: true, // 自适应过滤
      });
    case "webp":
      return pipeline.webp({
        quality: adaptiveQuality,
        smartSubsample: true, // 智能抽样，减少色彩伪影
        effort: optimalEffort, // 动态调整effort
        nearLossless: false,
      });
    case "avif":
      return pipeline.avif({
        quality: adaptiveQuality,
        effort: optimalEffort, // 动态调整effort
        chromaSubsampling: "4:2:0", // 色度抽样，减小体积
      });
    case "heic":
    case "heif":
      return pipeline.heif({
        quality: adaptiveQuality,
        compression: "hevc", // 编码器使用 HEVC
        chromaSubsampling: "4:2:0",
      });
    default:
      return pipeline.webp({
        quality: adaptiveQuality,
        smartSubsample: true,
        effort: optimalEffort,
        nearLossless: false,
      });
  }
}

/**
 * 统一存储服务 - 支持多存储类型和智能适配器管理
 *
 * 设计理念：
 * 1. 数据分类：将图片数据按存储类型分组
 * 2. 当前适配器处理：直接用当前配置的适配器处理对应类型的数据
 * 3. 备用适配器处理：为另一种类型创建临时适配器处理
 * 4. 性能优化：避免重复创建适配器实例
 */
class StorageService {
  /**
   * 创建存储服务实例
   * @param {Object|null} [config=null] - 可选配置，如果不提供则从环境变量读取
   */
  constructor(config = null) {
    // 当前配置的存储适配器（可能是本地存储或OSS）
    this.storage = StorageAdapterFactory.createAdapter(config);

    // 获取当前存储类型
    this._currentStorageType = this.storage.type;

    // 在实例化时就创建备用适配器
    this._backupAdapter = this._createBackupAdapter();
  }

  /**
   * 创建备用存储适配器（与当前适配器不同的类型）
   * @returns {Object} 备用存储适配器实例
   */
  _createBackupAdapter() {
    try {
      // 如果当前是本地存储，返回OSS适配器
      if (this._currentStorageType === STORAGE_TYPES.LOCAL) {
        return StorageAdapterFactory.createAdapter(STORAGE_TYPES.ALIYUN_OSS, false);
      }

      // 如果当前是OSS存储，返回本地适配器
      if (this._currentStorageType === STORAGE_TYPES.ALIYUN_OSS) {
        return StorageAdapterFactory.createAdapter(STORAGE_TYPES.LOCAL, false);
      }

      // 默认返回本地适配器
      return StorageAdapterFactory.createAdapter(STORAGE_TYPES.LOCAL, false);
    } catch (error) {
      // 如果创建备用适配器失败，回退到本地适配器
      logger.warn({
        message: "创建备用适配器失败，回退到本地适配器",
        details: { error: error.message },
      });
      return StorageAdapterFactory.createAdapter(STORAGE_TYPES.LOCAL, false);
    }
  }

  /**
   * 获取备用存储适配器（与当前适配器不同的类型）
   * @returns {Object} 备用存储适配器实例
   */
  getBackupStorageAdapter() {
    return this._backupAdapter;
  }

  /**
   * 获取OSS上传签名（用于直传）
   * @param {Object} options - 签名选项
   * @param {string} options.storageKey - OSS存储键
   * @param {string} options.contentType - 内容类型
   * @param {number} options.contentLength - 内容长度
   * @param {string} options.userId - 用户ID
   * @returns {Promise<Object>} 上传签名信息
   */
  async getUploadSignature({ storageKey, contentType, contentLength, userId }) {
    try {
      // 只有OSS适配器支持签名生成
      if (this._currentStorageType !== STORAGE_TYPES.ALIYUN_OSS) {
        logger.error({
          message: "Only OSS storage supports upload signature generation",
          details: {
            currentStorageType: this._currentStorageType,
            storageKey,
            contentType,
            contentLength,
            userId,
          },
        });
        throw new Error("Only OSS storage supports upload signature generation");
      }

      return await this.storage.getUploadSignature({
        storageKey,
        contentType,
        contentLength,
        userId,
      });
    } catch (error) {
      logger.error({
        message: "获取上传签名失败",
        details: {
          storageKey,
          contentType,
          contentLength,
          userId,
          error: error.message,
        },
      });
      throw error;
    }
  }

  /**
   * 智能获取文件完整URL
   * 根据图片的存储类型自动选择对应的存储适配器
   * @param {string} storageKey - 存储键名
   * @param {string} storageType - 存储类型
   * @returns {Promise<string|null>} 完整的文件访问URL
   */
  async getFileUrl(storageKey, storageType) {
    try {
      let adapter;

      // 根据存储类型选择对应的适配器
      if (storageType === this._currentStorageType) {
        adapter = this.storage;
      } else if (storageType === this._backupAdapter.type) {
        adapter = this._backupAdapter;
      } else {
        // 如果都不匹配，使用当前适配器作为默认
        adapter = this.storage;
      }

      return await adapter.getFileUrl(storageKey);
    } catch (error) {
      logger.error({
        message: "获取文件访问URL失败",
        details: {
          storageKey,
          storageType,
          error: error.message,
        },
      });
      return null;
    }
  }

  /**
   * 批量获取文件URL（优化版本）
   * 先对数据进行分类，然后批量处理，避免重复的适配器判断和创建
   * @param {Array<{storageKey: string, storageType: string}>} files - 文件信息数组
   * @returns {Promise<Array<{storageKey: string, storageType: string, url: string|null}>>} URL结果数组
   */
  async getFileUrls(files) {
    // 创建文件到索引的映射，保持原始顺序
    const fileToIndexMap = new Map();
    files.forEach((file, index) => {
      fileToIndexMap.set(file.storageKey, index);
    });

    // 按存储类型分组
    const currentTypeFiles = [];
    const otherTypeFiles = [];

    files.forEach((file) => {
      if (file.storageType === this._currentStorageType) {
        currentTypeFiles.push(file);
      } else {
        otherTypeFiles.push(file);
      }
    });

    // 初始化结果数组，保持原始顺序
    const results = new Array(files.length);

    // 1. 使用当前配置的适配器处理对应类型的数据（性能最优）
    if (currentTypeFiles.length > 0) {
      const currentUrls = await Promise.all(
        currentTypeFiles.map(async (file) => {
          try {
            const url = await this.storage.getFileUrl(file.storageKey);
            return { storageKey: file.storageKey, storageType: file.storageType, url };
          } catch (error) {
            logger.error({
              message: "获取文件URL失败",
              details: { storageKey: file.storageKey, storageType: file.storageType, error: error.message },
            });
            return { storageKey: file.storageKey, storageType: file.storageType, url: null };
          }
        }),
      );

      // 将结果放回原始位置
      currentUrls.forEach((result) => {
        const index = fileToIndexMap.get(result.storageKey);
        results[index] = result;
      });
    }

    // 2. 使用备用适配器处理其他类型的数据
    if (otherTypeFiles.length > 0) {
      const backupAdapter = this.getBackupStorageAdapter();

      const otherUrls = await Promise.all(
        otherTypeFiles.map(async (file) => {
          try {
            const url = await backupAdapter.getFileUrl(file.storageKey);
            return { storageKey: file.storageKey, storageType: file.storageType, url };
          } catch (error) {
            logger.error({
              message: "获取文件URL失败",
              details: { storageKey: file.storageKey, storageType: file.storageType, error: error.message },
            });
            return { storageKey: file.storageKey, storageType: file.storageType, url: null };
          }
        }),
      );

      // 将结果放回原始位置
      otherUrls.forEach((result) => {
        const index = fileToIndexMap.get(result.storageKey);
        results[index] = result;
      });
    }

    return results;
  }

  // ========== 业务方法（有实际价值的封装） ==========

  /**
   * 处理图片并存储（通过适配器自动处理不同存储类型）
   * @param {Object} options - 处理选项
   * @param {number} [options.fileSize] - 文件大小（字节），如果提供则跳过文件大小计算以提升性能
   * @param {string} options.sourceStorageKey - 源文件存储键名（本地存储为绝对路径，OSS为对象键名）
   * @param {string} options.targetStorageKey - 目标文件存储键名（本地存储为绝对路径，OSS为对象键名）
   * @param {string} options.extension - 目标图片扩展名，支持：'webp', 'avif', 'jpeg', 'jpg', 'png'
   * @param {number} [options.resizeWidth] - 调整宽度（像素），不提供则保持原始尺寸
   * @param {number} [options.quality=80] - 图片质量 (1-100)，数值越高质量越好但文件越大
   * @param {boolean} [options.withoutEnlargement=true] - 是否禁止放大，true时小图不会被放大到指定宽度
   * @param {string} [options.fit="inside"] - 调整模式：
   *   - 'cover': 覆盖整个区域，可能裁剪
   *   - 'contain': 包含在区域内，可能有空白
   *   - 'fill': 拉伸填充，可能变形
   *   - 'inside': 缩放到区域内，保持比例
   *   - 'outside': 缩放到覆盖区域，保持比例
   * @param {boolean} [options.fastShrinkOnLoad=true] - 是否启用快速缩放加载优化，可提升大图缩放性能
   * @param {Object} [options.optimizationOptions={}] - 图片优化选项配置
   * @param {boolean} [options.optimizationOptions.enableAdaptiveQuality=false] - 是否启用自适应质量调整，根据文件大小自动调整质量参数
   * @param {boolean} [options.optimizationOptions.enableDynamicEffort=true] - 是否启用动态effort调整，根据文件大小自动调整压缩努力程度
   * @returns {Promise<void>} 处理完成后的Promise
   * @throws {Error} 当源文件不存在、格式不支持或存储失败时抛出错误
   *
   * @example
   * // 基本用法：生成缩略图
   * await storageService.processAndStoreImage({
   *   sourceStorageKey: 'upload/original.jpg',
   *   targetStorageKey: 'thumbnail/thumb.webp',
   *   extension: 'webp',
   *   resizeWidth: 300,
   *   quality: 70
   * });
   *
   * @example
   * // 高级用法：自定义优化选项
   * await storageService.processAndStoreImage({
   *   sourceStorageKey: 'upload/large.png',
   *   targetStorageKey: 'highres/optimized.avif',
   *   extension: 'avif',
   *   resizeWidth: 1920,
   *   quality: 85,
   *   fit: 'cover',
   *   optimizationOptions: {
   *     enableAdaptiveQuality: false,
   *     enableDynamicEffort: true
   *   }
   * });
   */
  async processAndStoreImage({
    fileSize,
    sourceStorageKey,
    targetStorageKey,
    extension,
    resizeWidth,
    quality = 80,
    withoutEnlargement = true,
    fit = "inside",
    fastShrinkOnLoad = true,
    optimizationOptions = {},
  }) {
    // 获取适配器的输入数据（本地：绝对文件路径，OSS：Buffer）
    const inputData = await this.storage.getFileData(sourceStorageKey);
    fileSize = fileSize || (await this.storage.getFileSize(inputData));

    // 创建Sharp实例并应用自动旋转
    let pipeline = sharp(inputData, SHARP_CONFIG).rotate();

    // 统一的缩放处理
    if (resizeWidth) {
      pipeline = pipeline.resize({
        width: resizeWidth,
        fit,
        withoutEnlargement,
        fastShrinkOnLoad,
      });
    }

    // 统一的编码器选择逻辑
    const defaultOptions = { enableAdaptiveQuality: false, enableDynamicEffort: false };
    const finalOptions = { ...defaultOptions, ...optimizationOptions };
    pipeline = _applyEncoderByExt(pipeline, extension, quality, fileSize, finalOptions);

    // 通过适配器存储处理后的图片
    await this.storage.storeProcessedImage(pipeline, targetStorageKey);
  }

  /**
   * 删除文件并记录日志
   * @param {Object} fileInfo - 文件信息
   * @param {string} fileInfo.fileName - 文件名
   * @param {string} fileInfo.storageKey - 存储键名
   * @returns {Promise<void>}
   */
  async deleteFile({ fileName, storageKey }) {
    try {
      // 记录重复图片信息到日志
      logger.info({
        message: "image detected and removed",
        details: {
          fileName,
          storageKey,
          timestamp: Date.now(),
          action: "deleted",
        },
      });

      // 通过适配器删除文件
      await this.storage.deleteFile(storageKey);

      logger.info({
        message: "image file deleted successfully",
        details: { fileName, storageKey },
      });
    } catch (error) {
      logger.error({
        message: `Failed to delete image file: ${error?.message}`,
        stack: error?.stack,
        details: { storageKey, fileName },
      });
      // 即使删除失败也不要抛出错误，避免影响主流程
    }
  }
}

// 单例模式：避免重复创建StorageService实例
let storageServiceInstance = null;

/**
 * 获取StorageService单例实例
 * @returns {StorageService} StorageService实例
 */
function getStorageService() {
  if (!storageServiceInstance) {
    storageServiceInstance = new StorageService();
  }
  return storageServiceInstance;
}

// 导出单例实例，而不是类
module.exports = getStorageService();
