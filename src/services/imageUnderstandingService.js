/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 图片内容理解服务 - AI 驱动的智能图片分析
 *
 * 🧠 核心功能:
 * • OCR 文字识别 - 提取图片中的中文、英文文字内容
 * • 人脸识别分析 - 检测人脸数量、年龄、性别、情绪等
 * • 场景内容分析 - 识别图片类型、颜色特征、布局特征
 * • 语义向量生成 - 为图片和文本生成高维向量，支持相似度搜索
 * • 关键词提取 - 自动从内容中提取可搜索的关键词标签
 *
 * 🔄 处理流程:
 * 1. 并行执行多个 AI 任务 (OCR + 人脸识别 + 场景分析)
 * 2. 统一格式化输出结果
 * 3. 生成向量嵌入用于语义搜索
 * 4. 提取结构化标签数据
 *
 * 📦 依赖服务:
 * • Python PaddleOCR 服务 - OCR 文字识别
 * • Sharp - 图片处理和元数据提取
 * • Python 人脸识别服务 - 高级人脸分析
 */

const sharp = require("sharp");
const { createHash } = require("crypto");
const logger = require("../utils/logger");
const axios = require("axios");
const { getStandardMimeType } = require("../utils/fileUtils");

// 年龄段常量定义
const YOUNG_AGE_BUCKETS = ["0-2", "3-9", "10-19"]; // 儿童/青少年年龄段

/**
 * 🧠 图片内容理解服务类
 *
 * 职责:
 * • 初始化 Python 服务连接（OCR + 人脸识别）
 * • 协调多种 AI 任务并行执行
 * • 统一管理图片内容分析流程
 * • 提供向量生成和语义搜索能力
 *
 * @class ImageUnderstandingService
 */
class ImageUnderstandingService {
  /**
   * 🏗️ 构造函数 - 初始化服务
   *
   * @constructor
   * @description 自动初始化 Python 服务连接（人脸识别 + OCR）
   */
  constructor() {
    this.isInitialized = false; // 服务初始化状态
    this.pythonServiceUrl = process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

    // 异步初始化：构造后立即启动初始化流程
    this._initPromise = this.init();
  }

  /**
   * 🚀 异步初始化服务
   *
   * @async
   * @function init
   * @description 初始化 Python 服务连接（人脸识别 + OCR）
   * @throws {Error} 初始化失败时抛出异常
   *
   * 🔧 初始化步骤:
   * 1. 健康检查 Python 服务（人脸识别 + OCR）
   * 2. 设置服务状态为已初始化
   */
  async init() {
    try {
      // 🐍 检查 Python 服务健康状态（人脸识别 + OCR）
      await this._checkPythonService();

      this.isInitialized = true;
      logger.info({ message: "✅ 图片内容理解服务初始化完成" });
    } catch (error) {
      logger.error({ message: "❌ 图片内容理解服务初始化失败", details: { error: error.message } });
      throw error;
    }
  }

  /**
   * 🔒 确保服务已初始化
   *
   * @async
   * @private
   * @description 检查服务初始化状态，如果未初始化则执行初始化
   * @throws {Error} 初始化失败时抛出异常
   */
  async _ensureInitialized() {
    if (!this.isInitialized) {
      // 没有正在进行的初始化就开一个
      if (!this._initPromise) this._initPromise = this.init();

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
   * 🏥 Python 人脸识别服务健康检查
   *
   * @async
   * @private
   * @description 检测 Python 人脸识别服务是否正常运行
   *
   * 📡 检查内容:
   * • HTTP 健康检查接口可访问性 (5秒超时)
   * • 服务返回状态是否为 'healthy'
   * • 网络连接和响应状态
   *
   * ⚠️ 异常处理:
   * • 服务不可用时发出警告 (不影响其他功能)
   * • 记录详细的错误信息和服务器地址
   * • 允许其他 AI 功能继续工作
   */
  async _checkPythonService() {
    try {
      const response = await axios.get(`${this.pythonServiceUrl}/health`, {
        timeout: 5000, // 5秒超时
      });

      if (response.data.status === "healthy") {
        logger.info({ message: "✅ Python 人脸识别服务连接正常" });
      } else {
        throw new Error("Python 服务状态异常");
      }
    } catch (error) {
      logger.warn({ message: "⚠️ Python 人脸识别服务不可用，将跳过人脸识别功能" });
      logger.warn({ message: `🔗 服务地址: ${this.pythonServiceUrl}` });
      logger.warn({ message: `❌ 错误信息: ${error.message}` });
    }
  }

  /**
   * 🎨 主要图片内容理解处理入口
   *
   * @async
   * @function processImage
   * @param {Object} params - 参数对象
   * @param {Buffer|string} params.imageData - 图片数据 (Buffer 或文件路径)
   * @param {number} params.imageId - 图片ID
   * @returns {Object} 包含所有分析结果的对象
   *
   * 🚀 功能特点:
   * • 并行执行多种 AI 分析任务，提升处理速度
   * • 使用 Promise.allSettled 确保单个任务失败不影响整体
   * • 自动提取和生成可搜索的内容标签
   * • 返回结构化数据供数据库存储
   *
   * 📊 返回数据:
   * • ocrText - OCR识别的文字内容
   * • altText - 图片描述文本
   * • keywords - 提取的关键词
   * • faceCount/expressionTags/ageTags/genderTags - 人脸分析结果
   */
  // async processImage({ imageData, imageId }) {
  //   try {
  //     logger.info(`🚀 开始处理图片内容理解: ${imageId}`);

  //     // 🔒 确保服务已初始化
  //     await this._ensureInitialized();

  //     // 📊 获取图片元数据
  //     const metadata = await sharp(imageData).metadata();

  //     // 🔄 并行执行多个 AI 任务
  //     const [ocrResult, altText, faceResult] = await Promise.allSettled([
  //       this._extractOCR(imageData),
  //       this._generateAltText(imageData, metadata),
  //       this._extractFaceInfo(imageData),
  //     ]);

  //     // 🧹 整理和格式化结果
  //     const faceInfo = faceResult.status === "fulfilled" ? faceResult.value : {};
  //     const result = {
  //       ocrText: ocrResult.status === "fulfilled" ? ocrResult.value : "",
  //       altText: altText.status === "fulfilled" ? altText.value : "",
  //       keywords: this._extractKeywords(
  //         ocrResult.value || "",
  //         altText.value || "",
  //         this._extractPeopleTags(altText.value || ""),
  //         this._extractObjectTags(altText.value || ""),
  //       ),
  //       peopleTags: this._extractPeopleTags(altText.value || ""),
  //       objectTags: this._extractObjectTags(altText.value || ""),
  //       // 人脸识别结果
  //       faceCount: faceInfo.faceCount || 0,
  //       faceDescriptions: faceInfo.descriptions || "",
  //       faceLandmarks: faceInfo.landmarks || "",
  //       faceEmbeddings: faceInfo.embeddings || "",
  //       faceClusters: faceInfo.clusters || "",
  //       expressionTags: faceInfo.expressions || "",
  //       ageTags: faceInfo.ages || "",
  //       genderTags: faceInfo.genders || "",
  //     };

  //     logger.info(`✅ 图片内容理解完成: ${imageId}`, {
  //       ocrLength: result.ocrText.length,
  //       altText: result.altText.substring(0, 50) + "...",
  //     });

  //     return result;
  //   } catch (error) {
  //     logger.error(`❌ 图片内容理解失败: ${imageId}`, error);
  //     throw error;
  //   }
  // }

  /**
   * 👥 人脸识别专用处理方法
   *
   * @async
   * @function processImageFaceOnly
   * @param {Object} params - 参数对象
   * @param {Buffer|string} params.imageData - 图片数据 (Buffer 或文件路径)
   * @param {number} params.imageId - 图片ID
   * @returns {Object} 只包含人脸识别结果的对象
   *
   * 🚀 功能特点:
   * • 只执行人脸识别相关任务
   * • 返回人脸检测、年龄、性别、情绪等结果
   * • 用于分步测试人脸识别功能
   *
   * 📊 返回数据:
   * • faceCount - 人脸数量
   * • expressionTags - 表情标签
   * • ageTags - 年龄标签
   * • genderTags - 性别标签
   */
  async processImageFaceOnly({ imageData, imageId, storageKey }) {
    try {
      logger.info({ message: `👥 开始处理人脸识别: ${imageId}` });

      // 🔒 确保服务已初始化
      await this._ensureInitialized();

      // 👥 执行人脸识别
      const result = await this._extractFaceInfo(imageData, storageKey);

      logger.info({
        message: `✅ 人脸识别完成 imageid: ${imageId}`,
        details: { faceCount: result.faceCount },
      });

      return result;
    } catch (error) {
      logger.error({ message: `❌ 人脸识别失败 imageid: ${imageId}`, details: { error: error.message } });
      throw error;
    }
  }

  /**
   * 🔤 OCR文字识别提取（调用Python PaddleOCR服务）
   *
   * @async
   * @private
   * @function _extractOCR
   * @param {Buffer} imageData - 图片Buffer数据
   * @returns {Promise<string>} 识别的文字内容
   *
   * 🛠️ 处理流程:
   * 1. 调用Python服务的PaddleOCR接口
   * 2. 结果清洗 - 去除特殊字符，保留中文、英文、数字
   */
  async _extractOCR(imageData) {
    try {
      // 调用 Python 服务的 PaddleOCR 接口
      const formData = new FormData();
      formData.append("image", imageData, "image.jpg");

      const response = await axios.post(`${this.pythonServiceUrl}/ocr`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
        timeout: 300000,
      });

      const result = response.data;

      if (!result.text || result.text.length === 0) {
        return "";
      }

      // 🧹 清理OCR结果
      const cleanText = result.text
        .replace(/\s+/g, " ") // 将多个连续空白字符（空格、换行、制表符等）压缩为单个空格
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, "") // 只保留中文、英文字母、数字和空格，过滤掉其他所有字符
        .trim(); // 去除字符串首尾的空白字符

      return cleanText;
    } catch (error) {
      logger.error({ message: "❌ OCR识别失败", details: { error: error.message } });
      return "";
    }
  }

  /**
   * 生成图片描述文本
   * @param {Buffer|string} imageData - 图片数据 (Buffer 或文件路径)
   * @param {Object} metadata - 图片元数据
   * @returns {Promise<string>} 图片描述文本
   *
   * TODO: 当前实现只是基于元数据的简单规则，需要接入真正的AI图片内容识别
   * 可能的实现方案：
   * 1. 扩展Python服务，添加图片内容描述生成功能
   * 2. 调用外部AI服务（如OpenAI Vision API、百度AI等）
   * 3. 使用本地AI模型（如BLIP2、CLIP等）
   */
  async _generateAltText(imageData, metadata) {
    try {
      // 基于图片特征生成描述
      const descriptions = [];

      return descriptions.length > 0 ? descriptions.join("的") : "图片";
    } catch (error) {
      logger.error({ message: "生成图片描述失败", details: { error: error.message } });
      return "图片";
    }
  }

  /**
   * 从多个文本源中提取关键词
   * @param {string} ocrText - OCR识别的文字
   * @param {string} altText - 图片描述文字
   * @param {string} objectTags - 物体标签
   * @returns {string} 合并后的关键词字符串
   */
  _extractKeywords(ocrText, altText, objectTags) {
    // 合并所有文本内容
    const allTexts = [ocrText, altText, objectTags];
    const text = allTexts.join(" ").toLowerCase();
    const keywords = [];

    // 常见关键词
    const commonKeywords = [
      "风景",
      "人物",
      "建筑",
      "食物",
      "动物",
      "植物",
      "天空",
      "海洋",
      "山",
      "树",
      "汽车",
      "房子",
      "花",
      "草",
      "云",
      "太阳",
      "月亮",
      "星星",
      "水",
      "火",
    ];

    // 从文本中提取关键词
    commonKeywords.forEach((keyword) => {
      if (text.includes(keyword)) {
        keywords.push(keyword);
      }
    });

    // 添加标签中的关键词（去重）
    const tagKeywords = [objectTags]
      .filter((tag) => tag && tag.trim())
      .map((tag) => tag.split(",").map((t) => t.trim()))
      .flat()
      .filter((keyword) => keyword && !keywords.includes(keyword));

    keywords.push(...tagKeywords);

    return keywords.join(",");
  }

  /**
   * 👥 人脸信息提取（调用Python AI服务）
   *
   * @async
   * @private
   * @function _extractFaceInfo
   * @param {Buffer|string} imageData - 图片数据
   * @returns {Promise<Object>} 人脸分析结果对象
   *
   * 🤖 AI分析能力:
   * • 人脸检测 - 识别人脸数量
   * • 年龄估算 - 基于面部特征
   * • 性别识别 - 基于面部骨骼特征
   * • 情绪分析 - 基于表情识别
   * • 种族识别 - 基于面部特征 (已移除)
   *
   * 🔗 外部依赖: Python人脸识别微服务
   * 📊 返回格式: { faceCount, descriptions, emotions, ages, genders }
   */
  async _extractFaceInfo(imageData, storageKey) {
    try {
      // 调用 Python 服务进行人脸识别
      const formData = new FormData();

      // 从storageKey提取文件格式
      const mimeType = getStandardMimeType(storageKey);
      const fileName = this._getFileNameFromStorageKey(storageKey);

      const imageBlob = new Blob([imageData], { type: mimeType });
      formData.append("image", imageBlob, fileName);

      const response = await axios.post(`${this.pythonServiceUrl}/analyze_face`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
        timeout: 600000, // 10分钟超时，给模型下载(如果还没下载的话)足够时间
      });

      const result = response.data;
      logger.info({ message: "人脸识别结果", details: result });

      if (result.face_count === 0) {
        return {
          faceCount: 0,
          expressionTags: "",
          ageTags: "",
          genderTags: "",
          faces: [],
          primaryExpressionConfidence: null,
          hasYoung: false,
          hasAdult: false,
          primaryFaceQuality: null,
        };
      }

      // Python已经返回了summary，直接使用
      const { expressions = [], ages = [], genders = [] } = result.summary || {};

      // Python已经按质量排序，faces[0]就是主要人脸
      const primaryFace = result.faces[0];

      // 使用.some()高效判断：找到一个就返回，无需遍历所有
      const hasYoung = result.faces.some((face) => face.age_bucket && YOUNG_AGE_BUCKETS.includes(face.age_bucket));
      const hasAdult = result.faces.some((face) => face.age_bucket && face.age_bucket !== "unknown" && !YOUNG_AGE_BUCKETS.includes(face.age_bucket));

      return {
        faceCount: result.face_count,
        expressionTags: expressions.join(","),
        ageTags: ages.join(","),
        genderTags: genders.join(","),
        faces: result.faces,
        primaryExpressionConfidence: primaryFace?.expression_confidence || null,
        primaryFaceQuality: primaryFace?.quality_score || null,
        hasYoung,
        hasAdult,
      };
    } catch (error) {
      logger.error({ message: "人脸识别失败", details: { error: error.message } });
      throw error; // 重新抛出异常，让上层处理
    }
  }

  /**
   * 📁 从storageKey提取文件名
   * @param {string} storageKey - 存储键名
   * @returns {string} 文件名
   * @private
   */
  _getFileNameFromStorageKey(storageKey) {
    const fileName = storageKey.split("/").pop();
    return fileName || "image.jpg";
  }

  /**
   * 🧹 清理资源
   *
   * @async
   * @function cleanup
   * @description 释放OCR工作器和其他资源
   */
  async cleanup() {
    try {
      if (this.ocrWorker) {
        await this.ocrWorker.terminate();
        this.ocrWorker = null;
        logger.info({ message: "✅ OCR工作器已清理" });
      }
    } catch (error) {
      logger.error({ message: "❌ 清理OCR工作器失败", details: { error: error.message } });
    }
  }
}

// 单例模式实现
let instance = null;

/**
 * 获取 ImageUnderstandingService 单例实例
 * @returns {ImageUnderstandingService} 单例实例
 */
function getInstance() {
  if (!instance) {
    instance = new ImageUnderstandingService();
  }
  return instance;
}

module.exports = getInstance();
