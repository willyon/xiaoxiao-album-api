/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 图片元数据分析服务 - 统一处理所有图片元数据提取、分析和处理逻辑
 */

const logger = require("../utils/logger");
const sharp = require("sharp");
const exifr = require("exifr");
const exiftool = require("exiftool-vendored").exiftool;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { stringToTimestamp } = require("../utils/formatTime");
const { getMimeTypeByMagicBytes } = require("../utils/fileUtils");
const { getLocationFromCoordinates } = require("./geocodingService");
const imageModel = require("../models/imageModel");

// EXIF Orientation 字符串 → 数值映射（exiftool 常见输出）
const ORIENTATION_MAP = {
  "Horizontal (normal)": 1,
  "Mirror horizontal": 2,
  "Rotate 180": 3,
  "Mirror vertical": 4,
  "Mirror horizontal and rotate 270 CW": 5,
  "Rotate 90 CW": 6,
  "Mirror horizontal and rotate 90 CW": 7,
  "Rotate 270 CW": 8,
};

/**
 * 图片元数据分析服务
 * 统一处理所有图片元数据提取、分析和处理逻辑
 */
class ImageMetadataService {
  /**
   * 综合分析图片元数据
   * @param {Buffer|string} fileData - 图片文件数据（Buffer 或文件路径字符串）
   * @param {Object} options - 分析选项
   * @param {boolean} options.includeLocation - 是否包含位置描述（默认 false，避免网络请求）
   * @returns {Promise<Object>} 完整的元数据分析结果
   */
  async analyzeImageMetadata(fileData, options = {}) {
    try {
      // 1. 基础元数据分析（EXIF、尺寸、方向等）
      const basicMetadata = await this.extractImageMetadata(fileData);

      // 2. 方向和尺寸计算
      const orientationInfo = this.calculateOrientationInfo(basicMetadata.width, basicMetadata.height, basicMetadata.orientation);

      // 3. 地理位置分析（可选）
      let locationInfo = {};
      if (options.includeLocation && basicMetadata.latitude && basicMetadata.longitude) {
        locationInfo = await this.analyzeLocationInfo(basicMetadata.latitude, basicMetadata.longitude);
      }

      return {
        ...basicMetadata,
        ...orientationInfo,
        ...locationInfo,
      };
    } catch (error) {
      logger.error({ message: "图片元数据分析失败", details: { error: error.message } });
      throw error;
    }
  }

  /**
   * 图片元数据提取 - 兼容本地文件路径和Buffer
   * @param {string|Buffer} input - 文件路径（本地存储）或文件Buffer（OSS存储）
   * @returns {Promise<Object>} 标准化的元数据对象，包含以下字段：
   *   - captureTime: 拍摄时间戳 (如 1692087025000)
   *   - latitude: GPS纬度 (如 39.9042)
   *   - longitude: GPS经度 (如 116.4074)
   *   - altitude: GPS海拔 (如 43.5)
   *   - width: 图片宽度 (如 4032)
   *   - height: 图片高度 (如 3024)
   *   - orientation: EXIF方向值 (1-8) 或 null
   *   - mime: MIME类型 (如 'image/jpeg')
   */
  async extractImageMetadata(input) {
    try {
      let tempFilePath = null;
      // 统一处理输入，都转为 Buffer 给 exifr 使用
      let buffer = null;
      let filePath = null;
      let std = null;

      if (Buffer.isBuffer(input)) {
        buffer = input;
      } else if (typeof input === "string") {
        buffer = fs.readFileSync(input);
        filePath = input; // 保存文件路径给 exiftool 使用
      } else {
        throw new Error("INPUT_NOT_SUPPORTED: input must be Buffer or file path string");
      }

      // 首先尝试使用 exifr 解析（性能更好）
      try {
        const data = await exifr.parse(buffer, {
          exif: true, // 拍摄参数：拍摄时间、ISO、光圈、焦距、快门速度、曝光模式等
          tiff: true, // 基础信息：图片尺寸、相机品牌型号、方向、颜色空间等
          gps: true, // GPS信息：纬度、经度、海拔、GPS时间戳等
          xmp: false, // Adobe扩展元数据：编辑历史、版权信息、关键词等（通常不需要）
          icc: false, // 颜色配置文件：颜色空间定义（文件较大，影响性能）
          iptc: false, // 新闻摄影元数据：标题、描述、关键词、作者等（通常不需要）
        });
        if (data && Object.keys(data).length > 0) {
          logger.info({ message: "exifr 解析成功", details: { fieldsCount: Object.keys(data).length } });
          std = this._standardizeMetadata(data);
        }
      } catch (exifrError) {
        // exifr 解析失败，记录日志
        logger.warn({ message: "exifr 解析失败，尝试 exiftool", details: { error: exifrError.message } });
      }

      // exifr 失败时，使用 exiftool 作为备用方案（兼容性更好 例如可以读取到一些exifr库无法读取的部分heic格式的图片内容）
      try {
        let exiftoolData = null;
        if (!std) {
          if (filePath) {
            // 有文件路径，直接使用
            exiftoolData = await exiftool.read(filePath);
          } else {
            // 只有 Buffer，写入临时文件
            const unique = `${Date.now()}_${randomUUID()}`;
            tempFilePath = path.join(os.tmpdir(), `temp_image_${unique}.tmp`);
            fs.writeFileSync(tempFilePath, buffer);
            exiftoolData = await exiftool.read(tempFilePath);
          }
          logger.info({ message: "exiftool 解析成功", details: { fieldsCount: Object.keys(exiftoolData).length } });
          std = this._standardizeMetadata(exiftoolData);
        }
      } finally {
        // 清理临时文件
        if (tempFilePath) {
          try {
            fs.unlinkSync(tempFilePath);
          } catch (cleanupError) {
            logger.warn({ message: "清理临时文件失败", details: { error: cleanupError.message } });
          }
        }
      }

      // ===== 统一后处理：仅当缺少关键字段时，才读取一次 Sharp 元数据进行兜底 sharp能获取到的有用的字段有限 只能兜底以下这几个 =====
      try {
        if (!std) std = {};

        const needMime = !std.mime;
        const needWidth = !std.width;
        const needHeight = !std.height;

        if (needMime || needWidth || needHeight) {
          const sharpMeta = await sharp(buffer).metadata();

          if (needWidth && sharpMeta?.width) std.width = sharpMeta.width;
          if (needHeight && sharpMeta?.height) std.height = sharpMeta.height;

          if (needMime) {
            // 优先使用魔数检测（buffer 已在内存，零开销）
            // Sharp 的 format 对 AVIF/HEIC/HEIF 不够精确（统一返回 heif）
            std.mime = getMimeTypeByMagicBytes(buffer);
          }
        }

        return std;
      } catch (postErr) {
        return std || {};
      }
    } catch (error) {
      logger.error({ message: "EXIF解析完全失败", details: { error: error.message } });
      throw error;
    }
  }

  /**
   * 标准化元数据格式
   * @param {Object} rawData - 原始元数据
   * @returns {Object} 标准化的元数据对象
   *
   * 两个依赖库(exifr和exiftool)的字段差异：
   * - 经纬度: exifr提供latitude/longitude（数字），exiftool提供GPSLatitude/GPSLongitude（数字）
   * - 时间: exifr可能返回Date对象，exiftool返回字符串
   * - 尺寸、方向、MIME: 两个库字段名相同，直接使用
   */
  _standardizeMetadata(rawData) {
    const result = {};

    // 拍摄时间
    if (rawData.DateTimeOriginal) {
      // 统一转换为时间戳
      if (rawData.DateTimeOriginal instanceof Date) {
        // exifr 返回 Date 对象，转换为时间戳
        result.captureTime = rawData.DateTimeOriginal.getTime();
      } else if (rawData.DateTimeOriginal.rawValue) {
        // exiftool 返回对象，使用 rawValue 字段
        result.captureTime = stringToTimestamp(rawData.DateTimeOriginal.rawValue);
      } else if (typeof rawData.DateTimeOriginal === "string") {
        // 兜底策略：如果是字符串，尝试直接转换
        result.captureTime = stringToTimestamp(rawData.DateTimeOriginal);
      }
      // 其他情况（对象、数字、null等）直接忽略，不设置 captureTime
    }

    // GPS信息
    if (rawData.latitude !== undefined) {
      // exifr 成功时，直接提供 latitude 字段（数字类型）
      result.latitude = rawData.latitude;
    } else if (rawData.GPSLatitude !== undefined) {
      // exiftool 回退时，GPSLatitude 是数字类型
      result.latitude = rawData.GPSLatitude;
    }

    if (rawData.longitude !== undefined) {
      // exifr 成功时，直接提供 longitude 字段（数字类型）
      result.longitude = rawData.longitude;
    } else if (rawData.GPSLongitude !== undefined) {
      // exiftool 回退时，GPSLongitude 是数字类型
      result.longitude = rawData.GPSLongitude;
    }

    if (rawData.GPSAltitude !== undefined) {
      result.altitude = rawData.GPSAltitude;
    }

    // MIME类型
    result.mime = rawData.MIMEType ?? rawData.ContentType ?? rawData.FileTypeMime;

    // 宽高统一提取（含兜底）
    result.width = rawData.ExifImageWidth ?? rawData.PixelXDimension ?? rawData.ImageWidth ?? rawData.Width;
    result.height = rawData.ExifImageHeight ?? rawData.PixelYDimension ?? rawData.ImageHeight ?? rawData.Height;

    // Orientation 兜底与规范化
    const o = rawData.Orientation;
    if (typeof o === "number") result.orientation = o;
    else if (typeof o?.value === "number") result.orientation = o.value;
    else if (typeof o === "string") {
      result.orientation = ORIENTATION_MAP[o] || null;
    }
    return result;
  }

  /**
   * 根据原图尺寸和EXIF orientation计算旋正后的方向分类
   * @param {number} width - 原图宽度
   * @param {number} height - 原图高度
   * @param {number} rawOrientation - EXIF orientation值 (1-8)
   *   1: 正常方向 (0°)
   *   2: 水平翻转 (0° + 水平翻转)
   *   3: 旋转180° (180°)
   *   4: 旋转180° + 水平翻转 (180° + 水平翻转)
   *   5: 旋转90° + 水平翻转 (90° + 水平翻转)
   *   6: 旋转90° (90°)
   *   7: 旋转270° + 水平翻转 (270° + 水平翻转)
   *   8: 旋转270° (270°)
   * @returns {Object} 包含方向分类、宽高比和旋正后尺寸的对象
   */
  calculateOrientationInfo(width, height, rawOrientation = 1) {
    if (!width || !height) {
      return {
        layoutType: null,
        aspectRatio: null,
        displayWidth: width,
        displayHeight: height,
      };
    }

    // 根据EXIF orientation计算旋正后的显示尺寸
    let displayWidth = width;
    let displayHeight = height;

    // EXIF orientation 5,6,7,8 需要交换宽高（涉及90°/270°旋转）
    if ([5, 6, 7, 8].includes(rawOrientation)) {
      displayWidth = height;
      displayHeight = width;
    }

    // 计算宽高比（基于旋正后的尺寸）
    const aspectRatio = displayWidth / displayHeight;

    // 根据宽高比确定方向分类
    let orientationType;
    if (aspectRatio > 2.5) {
      orientationType = "panorama"; // 全景图
    } else if (aspectRatio > 1.2) {
      orientationType = "landscape"; // 横图
    } else if (aspectRatio < 0.8) {
      orientationType = "portrait"; // 竖图
    } else {
      orientationType = "square"; // 正方形
    }

    return {
      layoutType: orientationType,
      aspectRatio: Math.round(aspectRatio * 1000) / 1000, // 保留3位小数
      displayWidth,
      displayHeight,
    };
  }

  /**
   * 分析地理位置信息
   * @param {number} latitude - 纬度
   * @param {number} longitude - 经度
   * @returns {Promise<Object>} 位置信息
   */
  async analyzeLocationInfo(latitude, longitude) {
    try {
      const locationObj = await getLocationFromCoordinates(latitude, longitude);

      return {
        gpsLocation: locationObj?.formattedAddress || null,
        country: locationObj?.country || null,
        city: locationObj?.city || null,
      };
    } catch (error) {
      logger.warn({
        message: "地理位置分析失败",
        details: {
          latitude,
          longitude,
          error: error.message,
        },
      });

      return {
        gpsLocation: null,
        country: null,
        city: null,
      };
    }
  }

  /**
   * 异步分析地理位置信息（用于延迟处理）
   * @param {number} latitude - 纬度
   * @param {number} longitude - 经度
   * @param {number} imageId - 图片ID
   * @returns {Promise<void>}
   */
  async analyzeLocationInfoAsync(latitude, longitude, imageId) {
    try {
      const locationInfo = await this.analyzeLocationInfo(latitude, longitude);

      // 更新数据库
      await this.updateLocationInfo(imageId, locationInfo);

      logger.info({
        message: "地理位置信息异步分析完成",
        details: {
          imageId,
          latitude,
          longitude,
          gpsLocation: locationInfo.gpsLocation,
        },
      });
    } catch (error) {
      logger.warn({
        message: "地理位置信息异步分析失败",
        details: {
          imageId,
          latitude,
          longitude,
          error: error.message,
        },
      });
    }
  }

  /**
   * 更新数据库中的位置信息
   * @param {number} imageId - 图片ID
   * @param {Object} locationInfo - 位置信息
   */
  async updateLocationInfo(imageId, locationInfo) {
    try {
      await imageModel.updateLocationInfo(imageId, locationInfo);
    } catch (error) {
      logger.error({
        message: "更新位置信息失败",
        details: {
          imageId,
          locationInfo,
          error: error.message,
        },
      });
      throw error;
    }
  }
}

module.exports = new ImageMetadataService();
