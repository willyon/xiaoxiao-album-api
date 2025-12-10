/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类服务 - 调用 Python API 并处理聚类结果
 *
 * 📋 核心功能:
 * • 从数据库获取用户的所有人脸 embedding
 * • 调用 Python 服务的 /cluster_faces API 进行聚类
 * • 将聚类结果存储到 face_clusters 表
 * • 支持重新聚类（先删除旧数据）
 *
 * 🔄 处理流程:
 * 1. 从 face_embeddings 表获取用户的所有 embedding
 * 2. 调用 Python 服务的 /cluster_faces API
 * 3. 解析聚类结果，建立 face_embedding_id 与 cluster_id 的映射
 * 4. 删除旧的聚类数据（如果重新聚类）
 * 5. 批量插入新的聚类结果
 */

const axios = require("axios");
const logger = require("../utils/logger");
const {
  getFaceEmbeddingsByUserId,
  getOldThumbnailPathsByUserId,
  deleteFaceClustersByUserId,
  insertFaceClusters,
  getClusterStatsByUserId,
  getFaceEmbeddingsByIds,
  getImagesSharpnessByIds,
  updateFaceEmbeddingThumbnail,
  updateFaceClusterRepresentative,
  getOldClusterNameMapping,
  restoreClusterNames,
  setClusterCover,
  restoreClusterDefaultCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdsByClusterId,
  getDefaultCoverFaceEmbeddingId,
} = require("../models/faceClusterModel");
const { getImageStorageInfo } = require("../models/imageModel");
const storageService = require("../services/storageService");

// Python 服务 URL（从环境变量读取）
const PYTHON_SERVICE_URL = process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

// 默认聚类阈值（与 Python 服务配置文件保持一致，仅用于日志记录）
// 优化（2025-11-30）：使用余弦距离，阈值调整为 0.42（平衡聚类准确性和完整性）
// 注意：实际使用的阈值由 Python 服务的配置文件决定（config.py 中的 FACE_CLUSTERING_THRESHOLD）
// 如果调用时未提供 threshold 参数，Python 服务将使用配置文件中的默认值
// 这是余弦距离阈值，范围 [0, 2]，0.42 是平衡阈值，既能减少不同人被误合并，又能减少同一人被过度分割
const DEFAULT_CLUSTERING_THRESHOLD = 0.42;

/**
 * 执行人脸聚类
 * @param {Object} params - 参数对象
 * @param {number} params.userId - 用户ID
 * @param {number} [params.threshold] - 聚类阈值（可选，默认0.6，余弦距离）
 * @param {boolean} [params.recluster] - 是否重新聚类（删除旧数据，默认false）
 * @returns {Object} 聚类结果统计
 */
async function performFaceClustering({ userId, threshold, recluster = false }) {
  try {
    logger.info({
      message: `开始执行人脸聚类: userId=${userId}`,
      details: { threshold, recluster },
    });

    // 1. 获取用户的所有人脸 embedding（自动排除已经在手动聚类中的记录）
    const faceEmbeddings = getFaceEmbeddingsByUserId(userId);

    if (!faceEmbeddings || faceEmbeddings.length === 0) {
      logger.info({
        message: `用户 ${userId} 没有可聚类的人脸数据`,
      });
      return {
        success: true,
        clusterCount: 0,
        totalFaces: 0,
        message: "没有可聚类的人脸数据",
      };
    }

    logger.info({
      message: `获取到 ${faceEmbeddings.length} 个人脸 embedding（已自动排除手动聚类的记录）`,
      details: { userId },
    });

    // 2. 准备调用 Python API 的数据
    const embeddings = faceEmbeddings.map((fe) => fe.embedding);
    // 如果提供了自定义阈值，则使用；否则不传递 threshold，让 Python 使用配置文件的默认值
    const requestBody = {
      embeddings: embeddings,
    };

    // 只有在明确提供了 threshold 时才传递（允许覆盖配置文件的默认值）
    if (threshold !== undefined && threshold !== null) {
      requestBody.threshold = threshold;
    }

    // 3. 调用 Python 服务的聚类 API
    logger.info({
      message: `调用 Python 聚类服务: ${PYTHON_SERVICE_URL}/cluster_faces`,
      details: {
        embeddingCount: embeddings.length,
        threshold: threshold !== undefined && threshold !== null ? threshold : "使用配置文件默认值",
      },
    });

    const response = await axios.post(`${PYTHON_SERVICE_URL}/cluster_faces`, requestBody, {
      timeout: 300000, // 5分钟超时（大量数据可能需要较长时间）
      headers: {
        "Content-Type": "application/json",
      },
    });

    const clusters = response.data.clusters || [];

    if (!clusters || clusters.length === 0) {
      logger.warn({
        message: `Python 服务返回空聚类结果`,
        details: { userId, embeddingCount: embeddings.length },
      });
      return {
        success: true,
        clusterCount: 0,
        totalFaces: 0,
        message: "聚类结果为空",
      };
    }

    logger.info({
      message: `Python 服务返回 ${clusters.length} 个聚类`,
      details: {
        userId,
        clusterCount: clusters.length,
        totalFaces: embeddings.length,
      },
    });

    // 4. 解析聚类结果，建立映射关系
    // Python 返回的格式：
    // {
    //   clusters: [
    //     {
    //       cluster_id: 0,
    //       face_indices: [0, 1, 2],  // 这些是 embeddings 数组的索引
    //       face_count: 3
    //     },
    //     ...
    //   ]
    // }
    const clusterData = [];

    for (const cluster of clusters) {
      const clusterId = cluster.cluster_id;
      const faceIndices = cluster.face_indices || [];

      // 跳过噪声点（cluster_id = -1）
      if (clusterId === -1) {
        continue;
      }

      for (const faceIndex of faceIndices) {
        // faceIndex 是 embeddings 数组的索引，对应 faceEmbeddings 数组
        if (faceIndex >= 0 && faceIndex < faceEmbeddings.length) {
          const faceEmbedding = faceEmbeddings[faceIndex];

          clusterData.push({
            clusterId: clusterId,
            faceEmbeddingId: faceEmbedding.id,
            similarityScore: null, // Python 服务未返回相似度分数
            isRepresentative: false, // 默认不是代表人脸，后续可以优化选择
          });
        } else {
          logger.warn({
            message: `聚类结果索引越界: faceIndex=${faceIndex}, total=${faceEmbeddings.length}`,
            details: { userId, clusterId },
          });
        }
      }
    }

    logger.info({
      message: `解析完成，准备插入 ${clusterData.length} 条聚类数据`,
      details: { userId, clusterCount: clusters.length },
    });

    // 5. 如果重新聚类，先保存旧的缩略图路径和聚类名称映射（用于后续清理和名称恢复）
    let oldThumbnailPaths = [];
    let oldClusterNameMapping = null;
    if (recluster) {
      oldThumbnailPaths = getOldThumbnailPathsByUserId(userId);
      logger.info({
        message: `找到 ${oldThumbnailPaths.length} 个旧缩略图文件`,
        details: { userId },
      });

      // 保存旧的聚类名称映射（在删除前）
      oldClusterNameMapping = getOldClusterNameMapping(userId);
      logger.info({
        message: `找到 ${oldClusterNameMapping.size} 个有名称的旧聚类`,
        details: { userId },
      });

      // 删除旧的聚类数据（排除用户手动分配的记录，保护用户的手动调整）
      const deleteResult = deleteFaceClustersByUserId(userId, { excludeUserAssigned: true });
      logger.info({
        message: `删除旧聚类数据: ${deleteResult.affectedRows} 条（已排除用户手动分配的记录）`,
        details: { userId },
      });
    }

    // 6. 批量插入聚类结果
    const insertResult = insertFaceClusters(userId, clusterData);

    // 7. 如果重新聚类，尝试恢复聚类名称（根据新旧聚类的 face_embedding_id 重叠度匹配）
    // 使用一对一匹配策略，确保每个名称只分配给一个最匹配的新聚类
    if (recluster && oldClusterNameMapping && oldClusterNameMapping.size > 0) {
      const restoredCount = restoreClusterNames(userId, oldClusterNameMapping, clusterData, 0.6);
      logger.info({
        message: `恢复了 ${restoredCount} 个聚类的自定义名称（使用一对一匹配策略）`,
        details: { userId, totalOldNamedClusters: oldClusterNameMapping.size },
      });
    }

    logger.info({
      message: `✅ 人脸聚类完成`,
      details: {
        userId,
        clusterCount: clusters.length,
        insertedRows: insertResult.affectedRows,
        totalFaces: faceEmbeddings.length,
      },
    });

    // 8. 为每个cluster选择最佳人脸并生成缩略图
    const generatedThumbnailPaths = await _generateThumbnailsForClusters(userId, clusters, faceEmbeddings);

    // 9. 如果重新聚类，清理不再使用的旧缩略图
    if (recluster && oldThumbnailPaths.length > 0) {
      // 找出不再使用的缩略图（在旧列表中但不在新列表中）
      const newThumbnailPathsSet = new Set(generatedThumbnailPaths);
      const unusedThumbnailPaths = oldThumbnailPaths.filter((path) => !newThumbnailPathsSet.has(path));

      if (unusedThumbnailPaths.length > 0) {
        logger.info({
          message: `开始清理 ${unusedThumbnailPaths.length} 个不再使用的缩略图文件`,
          details: { userId, totalOld: oldThumbnailPaths.length, totalNew: generatedThumbnailPaths.length },
        });

        let deletedCount = 0;
        let failedCount = 0;
        for (const thumbnailPath of unusedThumbnailPaths) {
          try {
            await storageService.storage.deleteFile(thumbnailPath);
            deletedCount++;
          } catch (error) {
            failedCount++;
            // 如果文件不存在，不算错误（可能已经被删除）
            if (error.code !== "ENOENT" && error.status !== 404) {
              logger.warn({
                message: `删除不再使用的缩略图失败: ${thumbnailPath}`,
                details: { userId, error: error.message },
              });
            }
          }
        }
        logger.info({
          message: `清理不再使用的缩略图完成: 成功 ${deletedCount} 个，失败 ${failedCount} 个`,
          details: { userId, total: unusedThumbnailPaths.length },
        });
      } else {
        logger.info({
          message: `所有旧缩略图仍在使用中，无需清理`,
          details: { userId, totalOld: oldThumbnailPaths.length },
        });
      }
    }

    // 10. 获取聚类统计信息
    const stats = getClusterStatsByUserId(userId);

    return {
      success: true,
      clusterCount: stats.clusterCount,
      totalFaces: stats.totalFaces,
      uniqueFaceCount: stats.uniqueFaceCount,
      message: "聚类完成",
    };
  } catch (error) {
    logger.error({
      message: `人脸聚类失败: userId=${userId}`,
      details: {
        error: error.message,
        stack: error.stack,
        userId,
        threshold,
      },
    });

    // 如果是 Python 服务错误，提供更详细的错误信息
    if (error.response) {
      throw new Error(`Python 聚类服务错误: ${error.response.status} - ${error.response.data?.detail || error.message}`);
    }

    throw error;
  }
}

/**
 * 为每个cluster选择最佳人脸并生成缩略图
 * @param {number} userId - 用户ID
 * @param {Array} clusters - 聚类结果
 * @param {Array} faceEmbeddings - 人脸embedding列表
 * @returns {Promise<Array<string>>} 生成的缩略图路径列表
 */
async function _generateThumbnailsForClusters(userId, clusters, faceEmbeddings) {
  let successCount = 0;
  let failCount = 0;
  const MAX_ERRORS = 5; // 最大错误数，达到后停止处理
  const generatedThumbnailPaths = []; // 记录生成的缩略图路径

  for (const cluster of clusters) {
    const clusterId = cluster.cluster_id;
    const faceIndices = cluster.face_indices || [];

    if (clusterId === -1 || faceIndices.length === 0) {
      continue; // 跳过噪声点
    }

    try {
      // 1. 获取该cluster的所有人脸数据（需要包含完整信息）
      const clusterFaceIds = faceIndices.map((index) => faceEmbeddings[index]?.id).filter((id) => id != null);

      if (clusterFaceIds.length === 0) {
        continue;
      }

      // 2. 从数据库获取完整的人脸信息（包括quality_score、bbox、pose等）
      const clusterFaces = getFaceEmbeddingsByIds(clusterFaceIds);

      if (clusterFaces.length === 0) {
        continue;
      }

      // 3. 构建图片信息映射表（用于获取清晰度）
      const imageIds = [...new Set(clusterFaces.map((f) => f.image_id))];
      const imagesMap = getImagesSharpnessByIds(imageIds);

      // 4. 选择最佳人脸（动态计算，多级排序）
      const bestFace = _selectBestFace(clusterFaces, imagesMap);

      if (!bestFace) {
        logger.warn({
          message: `未找到最佳人脸: clusterId=${clusterId}`,
          details: { userId, clusterId, faceCount: clusterFaces.length },
        });
        continue;
      }

      // 5. 获取图片数据
      const imageInfo = getImageStorageInfo(bestFace.image_id);
      if (!imageInfo) {
        logger.warn({
          message: `图片不存在: imageId=${bestFace.image_id}`,
          details: { userId, clusterId },
        });
        continue;
      }

      // 6. 获取图片buffer（优先高清图）
      let imageData = null;
      let storageKey = imageInfo.highResStorageKey || imageInfo.originalStorageKey;

      if (storageKey) {
        try {
          imageData = await storageService.storage.getFileBuffer(storageKey);
        } catch (error) {
          logger.error({
            message: `获取图片数据失败: storageKey=${storageKey}`,
            details: { error: error.message, userId, clusterId },
          });
          continue;
        }
      }

      if (!imageData) {
        logger.warn({
          message: `无法获取图片数据: imageId=${bestFace.image_id}`,
          details: { userId, clusterId },
        });
        continue;
      }

      // 7. 调用Python服务生成缩略图
      // 确保bbox是数组格式（可能从数据库读取时是JSON字符串）
      let bbox = bestFace.bbox;
      if (typeof bbox === "string") {
        try {
          bbox = JSON.parse(bbox);
        } catch (e) {
          logger.error({
            message: `bbox JSON解析失败: clusterId=${clusterId}`,
            details: { userId, clusterId, faceEmbeddingId: bestFace.id, imageId: bestFace.image_id },
          });
          continue;
        }
      }

      // 检查bbox格式
      if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
        // 跳过bbox无效的cluster（历史数据或格式错误）
        continue;
      }

      if (!imageData || !Buffer.isBuffer(imageData)) {
        logger.error({
          message: `图片数据格式错误: clusterId=${clusterId}`,
          details: { userId, clusterId, imageId: bestFace.image_id },
        });
        continue;
      }

      const FormData = require("form-data");
      const formData = new FormData();
      formData.append("image", imageData, "image.jpg");
      // bbox需要作为Form字段传递（Python API期望Form参数）
      const bboxString = JSON.stringify(bbox);
      formData.append("bbox", bboxString);

      let response;
      try {
        response = await axios.post(`${PYTHON_SERVICE_URL}/generate_face_thumbnail`, formData, {
          headers: formData.getHeaders(),
          timeout: 30000, // 30秒超时
        });
      } catch (error) {
        failCount++;
        logger.error({
          message: `调用Python服务生成缩略图失败: clusterId=${clusterId} (错误${failCount}/${MAX_ERRORS})`,
          details: {
            error: error.message,
            status: error.response?.status,
            userId,
            clusterId,
            imageId: bestFace.image_id,
          },
        });

        // 如果错误达到上限，停止处理并抛出错误
        if (failCount >= MAX_ERRORS) {
          const errorMsg = `错误数量达到上限(${MAX_ERRORS})，停止生成缩略图`;
          logger.error({
            message: errorMsg,
            details: {
              userId,
              successCount,
              failCount,
              totalClusters: clusters.length,
            },
          });
          throw new Error(errorMsg); // 抛出错误，让调用方知道
        }

        continue; // 继续处理下一个cluster
      }

      const thumbnailBase64 = response.data.face_thumbnail_base64;

      if (!thumbnailBase64) {
        logger.warn({
          message: `Python服务未返回缩略图: clusterId=${clusterId}`,
          details: { userId, clusterId },
        });
        continue;
      }

      // 8. 存储缩略图
      const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");
      const thumbnailStorageKey = `localStorage/face-thumbnails/${bestFace.image_id}-${bestFace.face_index}.jpg`;

      await storageService.storage.storeFile(imageBuffer, thumbnailStorageKey, {
        contentType: "image/jpeg",
      });

      // 记录生成的缩略图路径
      generatedThumbnailPaths.push(thumbnailStorageKey);

      // 9. 更新face_embeddings表，设置face_thumbnail_storage_key
      updateFaceEmbeddingThumbnail(bestFace.id, thumbnailStorageKey);

      // 10. 更新face_clusters表，标记is_representative = true
      updateFaceClusterRepresentative(userId, clusterId, bestFace.id);

      successCount++;
      logger.info({
        message: `✅ 已为cluster生成缩略图: clusterId=${clusterId}`,
        details: { userId, clusterId, faceEmbeddingId: bestFace.id },
      });
    } catch (error) {
      logger.error({
        message: `生成缩略图失败: clusterId=${clusterId}`,
        details: {
          error: error.message,
          stack: error.stack,
          userId,
          clusterId,
        },
      });
      // 继续处理下一个cluster，不中断流程
    }
  }

  // 返回生成的缩略图路径列表
  return generatedThumbnailPaths;
}

/**
 * 选择最佳人脸（动态计算，多级排序策略）
 *
 * 🎯 设计理念：
 * - 不存储 cover_quality_score 字段，采用动态计算
 * - 灵活性强：可以随时调整选择策略，无需重新计算数据
 * - 性能影响小：选择封面是低频操作，计算开销可忽略
 *
 * 📊 选择策略（优先级从高到低）：
 * 1. quality_score（基础质量，权重最高）
 * 2. 表情（开心优先，如果有表情信息）
 * 3. pose得分（正面优先，yaw和pitch的绝对值越小越好）
 * 4. bbox面积（大脸优先）
 * 5. 清晰度（通过JOIN images表获取，可选）
 *
 * @param {Array} faces - 该cluster的所有人脸数据
 * @param {Map} imagesMap - 图片信息映射表（imageId -> {sharpness_score, ...}）
 * @returns {Object|null} 最佳人脸对象
 */
function _selectBestFace(faces, imagesMap = new Map()) {
  if (!faces || faces.length === 0) {
    return null;
  }

  // 解析bbox和pose（如果是JSON字符串）
  const facesWithMetrics = faces.map((face) => {
    let bbox = face.bbox;
    let pose = face.pose;

    // 解析bbox（如果是JSON字符串）
    if (typeof bbox === "string" && bbox.trim()) {
      try {
        bbox = JSON.parse(bbox);
      } catch (e) {
        // JSON解析失败，设置为null
        bbox = null;
      }
    }
    // 解析pose（如果是JSON字符串）
    if (typeof pose === "string" && pose.trim()) {
      try {
        pose = JSON.parse(pose);
      } catch (e) {
        // JSON解析失败，设置为null
        pose = null;
      }
    }

    // 计算bbox面积
    const bboxArea = bbox && bbox.length === 4 ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : 0;

    // 计算pose得分（yaw和pitch的绝对值越小越好）
    const yaw = pose?.yaw || 0;
    const pitch = pose?.pitch || 0;
    let poseScore = 1.0 - (Math.abs(yaw) / 90.0 + Math.abs(pitch) / 90.0) / 2.0;
    poseScore = Math.max(0.0, poseScore); // 确保不为负数

    // 表情优先级（如果有表情信息）
    const expressionPriority = {
      happy: 3,
      neutral: 2,
      surprise: 1,
      sad: 1,
      anger: 0,
      fear: 0,
      disgust: 0,
      contempt: 0,
    };
    const expressionScore = expressionPriority[face.expression] || 0;

    // 清晰度（通过JOIN images表获取）
    const imageInfo = imagesMap.get(face.image_id);
    const sharpnessScore = imageInfo?.sharpness_score || 0;

    return {
      ...face,
      bbox,
      pose,
      bboxArea,
      poseScore,
      qualityScore: face.quality_score || 0,
      expressionScore,
      sharpnessScore,
    };
  });

  // 多级排序（优先级从高到低）
  facesWithMetrics.sort((a, b) => {
    // 第一优先级：quality_score（基础质量，权重最高）
    if (Math.abs(a.qualityScore - b.qualityScore) > 0.05) {
      return b.qualityScore - a.qualityScore;
    }

    // 第二优先级：表情（开心优先）
    if (a.expressionScore !== b.expressionScore) {
      return b.expressionScore - a.expressionScore;
    }

    // 第三优先级：pose得分（正面优先）
    if (Math.abs(a.poseScore - b.poseScore) > 0.05) {
      return b.poseScore - a.poseScore;
    }

    // 第四优先级：bbox面积（大脸优先）
    if (Math.abs(a.bboxArea - b.bboxArea) > 1000) {
      return b.bboxArea - a.bboxArea;
    }

    // 第五优先级：清晰度（可选）
    if (Math.abs(a.sharpnessScore - b.sharpnessScore) > 0.05) {
      return b.sharpnessScore - a.sharpnessScore;
    }

    // 都相同，按时间排序（最新的优先）
    return (b.image_created_at || 0) - (a.image_created_at || 0);
  });

  return facesWithMetrics[0];
}

/**
 * 获取用户的聚类统计信息
 * @param {number} userId - 用户ID
 * @returns {Object} 聚类统计信息
 */
function getFaceClusterStats(userId) {
  return getClusterStatsByUserId(userId);
}

/**
 * 恢复聚类默认封面：清除手动设置的封面（is_representative = 2），恢复默认封面（is_representative = 1）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Promise<Object>} 返回 { faceEmbeddingId, thumbnailStorageKey } 或 null
 */
async function restoreDefaultCover(userId, clusterId) {
  try {
    // 1. 获取默认封面 face_embedding_id（is_representative = 1）
    const defaultFaceEmbeddingId = getDefaultCoverFaceEmbeddingId(userId, clusterId);

    if (!defaultFaceEmbeddingId) {
      logger.warn({
        message: `无法找到默认封面: clusterId=${clusterId}`,
        details: { userId, clusterId },
      });
      return null;
    }

    // 2. 验证该 face_embedding 是否存在且有效
    const faceEmbeddings = getFaceEmbeddingsByIds([defaultFaceEmbeddingId]);
    if (faceEmbeddings.length === 0) {
      logger.warn({
        message: `默认封面对应的 face_embedding 不存在: faceEmbeddingId=${defaultFaceEmbeddingId}`,
        details: { userId, clusterId },
      });
      return null;
    }

    const defaultFace = faceEmbeddings[0];

    // 3. 确保有缩略图（如果还没有，生成一个）
    let thumbnailStorageKey = defaultFace.face_thumbnail_storage_key;
    if (!thumbnailStorageKey) {
      thumbnailStorageKey = await generateThumbnailForFaceEmbedding(defaultFaceEmbeddingId);
      if (!thumbnailStorageKey) {
        logger.warn({
          message: `生成缩略图失败，但继续设置封面: faceEmbeddingId=${defaultFaceEmbeddingId}`,
          details: { userId, clusterId },
        });
      }
    }

    // 4. 恢复默认封面：清除手动设置的封面（is_representative = 2），确保默认封面（is_representative = 1）存在
    const result = restoreClusterDefaultCover(userId, clusterId, defaultFaceEmbeddingId);

    if (result.error || result.affectedRows === 0) {
      logger.error({
        message: `恢复默认封面失败: clusterId=${clusterId}`,
        details: { userId, clusterId, faceEmbeddingId: defaultFaceEmbeddingId, error: result.error },
      });
      return null;
    }

    logger.info({
      message: `✅ 已恢复默认封面: clusterId=${clusterId}`,
      details: { userId, clusterId, faceEmbeddingId: defaultFaceEmbeddingId },
    });

    return {
      faceEmbeddingId: defaultFaceEmbeddingId,
      thumbnailStorageKey,
    };
  } catch (error) {
    logger.error({
      message: `恢复默认封面失败: clusterId=${clusterId}`,
      details: {
        error: error.message,
        stack: error.stack,
        userId,
        clusterId,
      },
    });
    throw error;
  }
}

/**
 * 为单个 face_embedding 生成缩略图（如果还没有）
 * @param {number} faceEmbeddingId - face_embedding ID
 * @returns {Promise<string|null>} 返回缩略图存储键，如果生成失败则返回 null
 */
async function generateThumbnailForFaceEmbedding(faceEmbeddingId) {
  try {
    // 1. 获取 face_embedding 信息
    const faceEmbeddings = getFaceEmbeddingsByIds([faceEmbeddingId]);
    if (faceEmbeddings.length === 0) {
      logger.warn({
        message: `face_embedding 不存在: faceEmbeddingId=${faceEmbeddingId}`,
      });
      return null;
    }

    const faceEmbedding = faceEmbeddings[0];

    // 2. 检查是否已有缩略图
    if (faceEmbedding.face_thumbnail_storage_key) {
      return faceEmbedding.face_thumbnail_storage_key;
    }

    // 3. 获取图片数据
    const imageInfo = getImageStorageInfo(faceEmbedding.image_id);
    if (!imageInfo) {
      logger.warn({
        message: `图片不存在: imageId=${faceEmbedding.image_id}`,
        details: { faceEmbeddingId },
      });
      return null;
    }

    // 4. 获取图片buffer（优先高清图）
    let imageData = null;
    let storageKey = imageInfo.highResStorageKey || imageInfo.originalStorageKey;

    if (storageKey) {
      try {
        imageData = await storageService.storage.getFileBuffer(storageKey);
      } catch (error) {
        logger.error({
          message: `获取图片数据失败: storageKey=${storageKey}`,
          details: { error: error.message, faceEmbeddingId },
        });
        return null;
      }
    }

    if (!imageData) {
      logger.warn({
        message: `无法获取图片数据: imageId=${faceEmbedding.image_id}`,
        details: { faceEmbeddingId },
      });
      return null;
    }

    // 5. 准备 bbox
    let bbox = faceEmbedding.bbox;
    if (typeof bbox === "string") {
      try {
        bbox = JSON.parse(bbox);
      } catch (e) {
        logger.error({
          message: `bbox JSON解析失败: faceEmbeddingId=${faceEmbeddingId}`,
        });
        return null;
      }
    }

    // 检查bbox格式
    if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
      logger.warn({
        message: `bbox格式无效: faceEmbeddingId=${faceEmbeddingId}`,
      });
      return null;
    }

    if (!imageData || !Buffer.isBuffer(imageData)) {
      logger.error({
        message: `图片数据格式错误: faceEmbeddingId=${faceEmbeddingId}`,
      });
      return null;
    }

    // 6. 调用Python服务生成缩略图
    const FormData = require("form-data");
    const formData = new FormData();
    formData.append("image", imageData, "image.jpg");
    const bboxString = JSON.stringify(bbox);
    formData.append("bbox", bboxString);

    let response;
    try {
      response = await axios.post(`${PYTHON_SERVICE_URL}/generate_face_thumbnail`, formData, {
        headers: formData.getHeaders(),
        timeout: 30000, // 30秒超时
      });
    } catch (error) {
      logger.error({
        message: `调用Python服务生成缩略图失败: faceEmbeddingId=${faceEmbeddingId}`,
        details: {
          error: error.message,
          status: error.response?.status,
        },
      });
      return null;
    }

    const thumbnailBase64 = response.data.face_thumbnail_base64;

    if (!thumbnailBase64) {
      logger.warn({
        message: `Python服务未返回缩略图: faceEmbeddingId=${faceEmbeddingId}`,
      });
      return null;
    }

    // 7. 存储缩略图
    const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");
    const thumbnailStorageKey = `localStorage/face-thumbnails/${faceEmbedding.image_id}-${faceEmbedding.face_index}.jpg`;

    await storageService.storage.storeFile(imageBuffer, thumbnailStorageKey, {
      contentType: "image/jpeg",
    });

    // 8. 更新face_embeddings表，设置face_thumbnail_storage_key
    updateFaceEmbeddingThumbnail(faceEmbeddingId, thumbnailStorageKey);

    logger.info({
      message: `✅ 已为face_embedding生成缩略图: faceEmbeddingId=${faceEmbeddingId}`,
    });

    return thumbnailStorageKey;
  } catch (error) {
    logger.error({
      message: `生成缩略图失败: faceEmbeddingId=${faceEmbeddingId}`,
      details: {
        error: error.message,
        stack: error.stack,
      },
    });
    return null;
  }
}

module.exports = {
  performFaceClustering,
  getFaceClusterStats,
  generateThumbnailForFaceEmbedding,
  restoreDefaultCover,
};
