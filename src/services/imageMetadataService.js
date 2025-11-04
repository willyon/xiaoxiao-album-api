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
  // P1-3：颜色主题判定阈值配置（便于后续调整和数据驱动优化）
  constructor() {
    this.colorThresholds = {
      // 亮度阈值（归一化到 0-1）
      BRIGHT_LUMA: 0.65, // 🔧 调优：从0.7降到0.65（2025-10-26）让更多图片判为明快
      DARK_LUMA: 0.3, // 昏暗阈值（从0.35降到0.3，更清晰定义"暗"）

      // 饱和度阈值（归一化到 0-1）
      SAT_HIGH_MED: 0.5, // 高饱和度阈值-中位数（从0.45提升到0.5）
      SAT_HIGH_P80: 0.5, // 🔧 调优：从0.55降到0.50（2025-10-26）让更多图片判为鲜艳
      SAT_LOW: 0.15, // 低饱和度阈值（从0.25降到0.15，更清晰判断灰度）
      SAT_GRAY: 0.12, // 灰度图判定阈值

      // 色彩丰度阈值
      CF_HIGH: 0.25, // 🔧 调优：从0.3降到0.25（2025-10-26）让更多图片判为色彩丰富
      CF_GRAY: 0.12, // 灰度图色彩丰度阈值

      // 占比阈值（新增）
      BRIGHT_SHARE: 0.3, // 🔧 调优：从0.35降到0.30（2025-10-26）降低亮像素占比要求
      DARK_SHARE: 0.35, // 暗像素占比阈值
      SAT_SHARE_HIGH: 0.2, // 🔧 调优：从0.25降到0.20（2025-10-26）降低饱和像素占比要求
      SAT_SHARE_LOW: 0.15, // 高饱和像素占比-低阈值

      // 动态范围阈值
      DYN_RANGE_LOW: 0.22, // 低对比度阈值（从0.25降到0.22）
      DYN_RANGE_HIGH: 0.4, // 高对比度阈值（新增，用于黑白高对比图）
    };
  }

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

      // 3. 颜色分析
      const { colorTheme } = await this.analyzeColor(fileData, basicMetadata);

      // 4. 地理位置分析（可选）
      let locationInfo = {};
      if (options.includeLocation && basicMetadata.latitude && basicMetadata.longitude) {
        locationInfo = await this.analyzeLocationInfo(basicMetadata.latitude, basicMetadata.longitude);
      }

      return {
        ...basicMetadata,
        ...orientationInfo,
        colorTheme,
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
   * 分析图片颜色主题
   * @param {Buffer} fileData - 图片文件数据
   * @param {Object} metadata - 基础元数据（仅用于日志，不影响分析）
   * @returns {Promise<Object>} {colorTheme}
   */
  async analyzeColor(fileData, metadata) {
    // P0-1 修复：只检查 fileData，让 sharp 自己处理尺寸和格式
    if (!fileData) {
      return { colorTheme: "neutral" };
    }

    try {
      // 只处理一次图像，使用更小的尺寸提升性能
      // 显式转换为 sRGB 色彩空间，确保颜色分析的一致性
      const { data, info } = await sharp(fileData)
        .resize(64, 64, { fit: "inside", withoutEnlargement: true })
        .toColorspace("srgb") // 显式确保 sRGB 色彩空间
        .raw()
        .toBuffer({ resolveWithObject: true });

      // 计算颜色主题
      const colorTheme = this.calculateColorTheme(data, info);

      return { colorTheme };
    } catch (error) {
      logger.warn({
        message: "图片颜色分析失败，使用默认值",
        details: { error: error.message },
      });
      return { colorTheme: "neutral" };
    }
  }

  /**
   * 基于已处理图像数据计算颜色主题
   * P0-3/P1-2 重构：增加灰度快速通道，使用双轨统计指标（中位数+占比+上分位数）
   * @param {Buffer} data - 已处理的像素数据（RGB/RGBA格式，64x64缩放后）
   * @param {Object} info - 图片信息 {width, height, channels}
   * @returns {string} 颜色主题:
   *   - 'vibrant' | 'bright' | 'neutral' | 'muted' | 'dim'
   *   对应中文: '鲜艳' | '明亮' | '中性' | '柔和' | '暗淡'
   */
  calculateColorTheme(data, info) {
    // 获取颜色分析结果（包含新增的双轨统计指标）
    const { medLuma, medSat, satP80, dynRange, colorfulnessNorm, brightShare, darkShare, satShare } = this._analyzeColorsRobust(data, info);

    // 从配置中获取阈值
    const T = this.colorThresholds;

    // ========== P0-3：灰度/低饱和图像快速通道 ==========
    // 若整体低饱和（satP80 和 colorfulnessNorm 都很低），判定为灰度图
    if (satP80 < T.SAT_GRAY && colorfulnessNorm < T.CF_GRAY) {
      // 灰度图：只看亮度和对比度
      // 1. 亮像素占比高或中位数亮度高 → bright
      if (brightShare >= T.BRIGHT_SHARE || medLuma >= T.BRIGHT_LUMA) {
        return "bright";
      }
      // 2. 暗像素占比高或中位数亮度低 → dim
      if (darkShare >= T.DARK_SHARE || medLuma <= T.DARK_LUMA) {
        return "dim";
      }
      // 3. 中间灰度 → neutral
      return "neutral";
    }

    // ========== P1-2：有色彩图像 - 使用双轨判定逻辑 ==========

    // 【分支1】明亮图片：亮像素占比高 或 中位数亮度高
    if (brightShare >= T.BRIGHT_SHARE || medLuma >= T.BRIGHT_LUMA) {
      // 高饱和像素占比高 或 高色彩丰度 → vibrant（鲜艳）
      if (satShare >= T.SAT_SHARE_HIGH || colorfulnessNorm >= T.CF_HIGH) {
        return "vibrant";
      }
      // 否则 → bright（明亮）
      return "bright";
    }

    // 【分支2】昏暗图片：暗像素占比高 或 中位数亮度低
    if (darkShare >= T.DARK_SHARE || medLuma <= T.DARK_LUMA) {
      // 有一定饱和度（用P80捕捉显著区域）或色彩丰度 → muted（柔和）
      if (satShare >= T.SAT_SHARE_LOW || colorfulnessNorm >= T.CF_HIGH * 0.8) {
        return "muted";
      }
      // 否则 → dim（暗淡）
      return "dim";
    }

    // 【分支3】中间亮度区间
    // 3.1 高饱和P80分位数 或 高色彩丰度 → vibrant（鲜艳）
    if (satP80 >= T.SAT_HIGH_P80 || colorfulnessNorm >= T.CF_HIGH) {
      return "vibrant";
    }

    // 3.2 低饱和且低对比度 → dim（暗淡）
    if (medSat <= T.SAT_LOW && dynRange < T.DYN_RANGE_LOW) {
      return "dim";
    }

    // 3.3 低饱和但高对比度（黑白高对比图）→ bright
    if (medSat <= T.SAT_LOW && dynRange >= T.DYN_RANGE_HIGH) {
      return "bright";
    }

    // 3.4 其他情况 → neutral（中性）
    return "neutral";
  }

  /**
   * 稳健的颜色分析算法
   * 使用中位数统计、感知亮度计算和色彩丰度分析，提升分析准确性
   * @param {Buffer} data - RGB/RGBA像素数据（uint8格式，64x64缩放后）
   * @param {Object} info - 图片信息 {width, height, channels}
   * @returns {Object} 颜色分析结果
   *   - medLuma: 亮度中位数 (0-1)
   *   - medSat: 饱和度中位数 (0-1)
   *   - satP80: 饱和度80分位数 (0-1) 【新增】
   *   - dynRange: 动态范围 (P90-P10, 0-1)
   *   - colorfulnessNorm: 归一化色彩丰度 (0-1)
   *   - brightShare: 亮像素占比 (luma >= 0.8) 【新增】
   *   - darkShare: 暗像素占比 (luma <= 0.2) 【新增】
   *   - satShare: 高饱和像素占比 (sat >= 0.6) 【新增】
   */
  _analyzeColorsRobust(data, info) {
    const W = info.width,
      H = info.height,
      C = info.channels;

    // P0-2 修复：处理不同通道数
    const hasAlpha = C === 4;
    const isGrayscale = C === 1 || C === 2;

    // 存储每个像素的亮度和饱和度
    const lumas = [];
    const sats = [];

    // 色彩丰度计算：使用 opponent color channels (rg, yb)
    let rgMean = 0,
      ybMean = 0;
    let rgM2 = 0,
      ybM2 = 0; // 用于计算方差（Welford算法）
    let n = 0;

    // P1-1 新增：占比统计计数器
    let brightCount = 0,
      darkCount = 0,
      satCount = 0;
    let validPixels = 0;

    // 遍历所有像素，计算各项指标
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += C) {
        let r, g, b, a;

        // P0-2：处理不同通道数
        if (isGrayscale) {
          // 灰度图：r=g=b
          r = g = b = data[i];
          a = 255;
        } else if (hasAlpha) {
          // RGBA：读取alpha通道
          r = data[i];
          g = data[i + 1];
          b = data[i + 2];
          a = data[i + 3];

          // P0-2 关键修复：跳过透明像素（alpha < 10）
          if (a < 10) continue;
        } else {
          // RGB
          r = data[i];
          g = data[i + 1];
          b = data[i + 2];
          a = 255;
        }

        validPixels++;

        // 1. 感知亮度计算（sRGB luma，更符合人眼感知）
        // 公式：Y' = 0.2126*R + 0.7152*G + 0.0722*B
        const yPrime = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const luma = yPrime / 255; // 归一化到 [0,1]
        lumas.push(luma);

        // P1-1：统计亮暗像素占比
        if (luma >= 0.8) brightCount++;
        if (luma <= 0.2) darkCount++;

        // 2. HSV 饱和度计算
        const maxv = Math.max(r, g, b),
          minv = Math.min(r, g, b);
        const S = maxv === 0 ? 0 : (maxv - minv) / maxv; // 0~1
        sats.push(S);

        // P1-1：统计高饱和像素占比
        if (S >= 0.6) satCount++;

        // 3. 色彩丰度计算（Hasler–Süsstrunk算法）
        // opponent color channels: rg = R-G, yb = 0.5*(R+G) - B
        const rg = r - g;
        const yb = 0.5 * (r + g) - b;

        // 在线更新均值/方差（Welford算法，避免数值不稳定）
        n++;
        const drg = rg - rgMean;
        rgMean += drg / n;
        rgM2 += drg * (rg - rgMean);
        const dyb = yb - ybMean;
        ybMean += dyb / n;
        ybM2 += dyb * (yb - ybMean);
      }
    }

    // 处理边缘情况：没有有效像素
    if (validPixels === 0) {
      return {
        medLuma: 0.5,
        medSat: 0,
        satP80: 0,
        dynRange: 0,
        colorfulnessNorm: 0,
        brightShare: 0,
        darkShare: 0,
        satShare: 0,
      };
    }

    // 计算分位数（中位数、P10、P90、P80）
    const quantile = (arr, q) => {
      const tmp = Array.from(arr).sort((a, b) => a - b);
      const pos = (tmp.length - 1) * q;
      const base = Math.floor(pos);
      const frac = pos - base;
      return tmp[base] + (tmp[base + 1] - tmp[base] || 0) * frac;
    };

    // 计算亮度中位数和动态范围
    const medLuma = quantile(lumas, 0.5); // 亮度中位数
    const p10 = quantile(lumas, 0.1); // 10%分位数
    const p90 = quantile(lumas, 0.9); // 90%分位数
    const dynRange = Math.max(0, p90 - p10); // 动态范围

    // 计算饱和度中位数和P80分位数
    const medSat = quantile(sats, 0.5); // 饱和度中位数
    const satP80 = quantile(sats, 0.8); // P1-1 新增：饱和度80分位数（捕捉显著区域）

    // 色彩丰度计算（Hasler–Süsstrunk）
    const rgStd = Math.sqrt(rgM2 / Math.max(1, n - 1));
    const ybStd = Math.sqrt(ybM2 / Math.max(1, n - 1));
    const colorfulness = Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);

    // 经验归一化：大约 /100 映射到 0~1 左右（64x64 缩放后经验值）
    const colorfulnessNorm = Math.min(1, colorfulness / 100);

    // P1-1 新增：计算占比指标（解决"少量但显著"问题）
    const brightShare = brightCount / validPixels; // 亮像素占比
    const darkShare = darkCount / validPixels; // 暗像素占比
    const satShare = satCount / validPixels; // 高饱和像素占比

    return {
      medLuma, // 亮度中位数 (0-1)
      medSat, // 饱和度中位数 (0-1)
      satP80, // P1-1 新增：饱和度80分位数 (0-1)
      dynRange, // 动态范围 (0-1)
      colorfulnessNorm, // 归一化色彩丰度 (0-1)
      brightShare, // P1-1 新增：亮像素占比 (0-1)
      darkShare, // P1-1 新增：暗像素占比 (0-1)
      satShare, // P1-1 新增：高饱和像素占比 (0-1)
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
