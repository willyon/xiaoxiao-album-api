/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @LastEditors: zhangshouchangs
 * @LastEditTime: 2025-10-17
 * @Description: 搜索索引处理 Ingestor - 人脸识别队列处理器
 *
 * 📋 核心职责:
 * • 接收人脸识别任务队列
 * • 调用Python人脸识别服务分析图片
 * • 将分析结果存储到数据库
 *   - images表：存储汇总信息（人脸数量、标签、置信度等）
 *   - face_embeddings表：存储每个人脸的详细信息和特征向量
 *
 * 🔄 处理流程:
 * 1. 从存储服务获取图片数据（优先原图，其次高清图）
 * 2. 调用imageUnderstandingService.processImageFaceOnly进行人脸识别
 * 3. 将汇总结果更新到images表
 * 4. 将每个人脸的embedding存储到face_embeddings表
 *
 * 📊 存储的数据字段:
 * • faceCount - 人脸数量
 * • expressionTags - 表情标签（逗号分隔）
 * • ageTags - 年龄段标签（逗号分隔）
 * • genderTags - 性别标签（逗号分隔）
 * • primaryExpressionConfidence - 主要人物表情置信度
 * • primaryFaceQuality - 主要人脸质量
 * • hasYoung - 是否包含青少年（0-19岁，快速筛选）
 * • hasAdult - 是否包含成人（20岁以上，快速筛选）
 * • avgFaceQuality - 平均人脸质量
 *
 * 🔧 依赖服务:
 * • imageUnderstandingService - 图片内容理解服务（调用Python人脸识别服务）
 * • storageService - 存储服务（获取图片数据）
 * • imageModel - 数据库操作（updateImageSearchMetadata, insertFaceEmbeddings）
 */

const imageUnderstandingService = require("../services/imageUnderstandingService");
const { updateImageSearchMetadata, insertFaceEmbeddings } = require("../models/imageModel");
const storageService = require("../services/storageService");
const logger = require("../utils/logger");

/**
 * 处理搜索索引任务
 */
// async function processSearchIndex(job) {
//   const { imageId, userId, highResStorageKey, originalStorageKey } = job.data;

//   try {
//     logger.info({ message: `开始处理搜索索引: ${imageId}` });

//     // 1. 获取图片数据，优先使用原图，如果没有则使用高清图，都不存在则不处理
//     let imageData = null;
//     let storageKey = null;

//     if (originalStorageKey) {
//       storageKey = originalStorageKey;
//       imageData = await _getImageData(storageKey);
//     }

//     if (!imageData && highResStorageKey) {
//       storageKey = highResStorageKey;
//       imageData = await _getImageData(storageKey);
//     }

//     if (!imageData) {
//       throw new Error(`无法找到图片文件: 原图(${originalStorageKey}) 和 高清图(${highResStorageKey}) 都不存在`);
//     }

//     // 2. 图片内容理解
//     const understandingResult = await imageUnderstandingService.processImage({
//       imageData, // 图片buffer
//       imageId,
//     });

//     // 3. 生成向量（使用原始图片数据）
//     const [imageEmbedding, textEmbedding] = await Promise.all([
//       imageUnderstandingService.generateImageEmbedding(imageData), // 这里可能是Buffer或文件路径
//       imageUnderstandingService.generateTextEmbedding(
//         `${understandingResult.altText} ${understandingResult.ocrText} ${understandingResult.keywords}`,
//       ),
//     ]);

//     // 4. 更新数据库
//     await updateImageSearchMetadata({
//       imageId,
//       altText: understandingResult.altText,
//       ocrText: understandingResult.ocrText,
//       keywords: understandingResult.keywords,
//       sceneTags: understandingResult.sceneTags,
//       peopleTags: understandingResult.peopleTags,
//       objectTags: understandingResult.objectTags,
//       faceCount: understandingResult.faceCount,
//       faceDescriptions: understandingResult.faceDescriptions,
//       expressionTags: understandingResult.expressionTags,
//       ageTags: understandingResult.ageTags,
//       genderTags: understandingResult.genderTags,
//       imageEmbedding,
//       textEmbedding,
//     });
//   } catch (error) {
//     const errorMessage = error.message || "unknown_error";

//     // 根据错误类型确定失败原因
//     let reason;
//     if (errorMessage.includes("无法找到图片文件")) {
//       reason = "image_file_not_found";
//     } else {
//       reason = "general_processing_failed";
//     }

//     logger.error(`搜索索引处理失败: ${imageId}`, {
//       reason,
//       error: error.message,
//       stack: error.stack,
//       imageId,
//       userId,
//       highResStorageKey,
//       originalStorageKey,
//     });

//     throw error;
//   }
// }

/**
 * 处理人脸识别任务
 */
async function processFaceRecognition(job) {
  const { imageId, userId, highResStorageKey, originalStorageKey } = job.data;

  try {
    // 1. 获取图片数据
    // 策略：优先使用高清图（AVIF/WebP格式，imageUnderstandingService会自动转换）
    // 原图可能是HEIC格式，也会自动转换，但文件更大
    // 2048px高清图对人脸识别完全足够（模型本身会缩放到640x640）
    let imageData = null;
    let storageKey = null;

    // 优先使用高清图（如果存在）
    if (highResStorageKey) {
      storageKey = highResStorageKey;
      imageData = await _getImageData(storageKey);
      logger.info({ message: `使用高清图进行人脸识别: ${imageId}` });
    }

    // 降级：如果高清图不存在，使用原图
    if (!imageData && originalStorageKey) {
      storageKey = originalStorageKey;
      imageData = await _getImageData(storageKey);
      logger.info({ message: `使用原图进行人脸识别: ${imageId}` });
    }

    if (!imageData) {
      throw new Error(`无法找到图片文件: 高清图(${highResStorageKey}) 和 原图(${originalStorageKey}) 都不存在`);
    }

    // 2. 人脸识别处理
    const faceResult = await imageUnderstandingService.processImageFaceOnly({
      imageData, // 图片buffer
      imageId,
      storageKey, // 传递storageKey用于格式检测
    });

    // 解构出需要的数据
    const {
      faceCount,
      personCount,
      expressionTags,
      ageTags,
      genderTags,
      primaryExpressionConfidence,
      primaryFaceQuality,
      hasYoung,
      hasAdult,
      faces,
    } = faceResult;

    // 3. 更新数据库 - 更新images表的人脸识别相关字段
    await updateImageSearchMetadata({
      imageId,
      faceCount,
      personCount, // 2025-10-27 新增：人体检测数量（包括背面、远景）
      expressionTags,
      ageTags,
      genderTags,
      primaryExpressionConfidence,
      primaryFaceQuality,
      hasYoung,
      hasAdult,
    });

    // 4. 插入人脸特征向量到face_embeddings表
    // 优化（2025-10-27）：只存储高质量人脸的 embedding（用于聚类）
    // 原因：低质量人脸的 embedding 不准确，会污染聚类结果
    if (faces && faces.length) {
      const highQualityFaces = faces.filter((face) => face.is_high_quality);

      if (highQualityFaces.length > 0) {
        await insertFaceEmbeddings(imageId, highQualityFaces);
        logger.info({
          message: `✅ 人脸特征向量已存储 imageid: ${imageId}`,
          details: {
            total: faces.length,
            highQuality: highQualityFaces.length,
            lowQuality: faces.length - highQualityFaces.length,
          },
        });
      } else {
        logger.info({
          message: `⚠️ 检测到 ${faces.length} 张人脸，但无高质量人脸，跳过 embedding 存储`,
          details: { imageId },
        });
      }
    }

    logger.info({
      message: `✅  processFaceRecognition方法调用 人脸识别处理完成 imageid: ${imageId}`,
      details: {
        faceCount,
        ageTags,
        genderTags,
        expressionTags,
        hasYoung,
        hasAdult,
      },
    });
  } catch (error) {
    const errorMessage = error.message || "unknown_error";

    // 根据错误类型确定失败原因
    let reason;
    if (errorMessage.includes("无法找到图片文件")) {
      reason = "image_file_not_found";
    } else {
      reason = "face_recognition_failed";
    }

    logger.error({
      message: `人脸识别处理失败: ${imageId}`,
      details: {
        reason,
        error: error.message,
        stack: error.stack,
        imageId,
        userId,
        highResStorageKey,
        originalStorageKey,
      },
    });

    throw error;
  }
}

/**
 * 获取图片数据 - 统一返回Buffer格式
 * @param {string} storageKey - 存储键
 * @returns {Promise<Buffer|null>} 图片Buffer数据，失败返回null
 */
async function _getImageData(storageKey) {
  try {
    // 直接调用适配器的getFileBuffer方法，统一返回Buffer
    return await storageService.storage.getFileBuffer(storageKey);
  } catch (error) {
    logger.error({
      message: `获取图片数据失败: ${storageKey}`,
      details: { error: error.message },
    });
    return null;
  }
}

module.exports = {
  // processSearchIndex,
  processFaceRecognition,
  _getImageData, // 导出用于测试
};
