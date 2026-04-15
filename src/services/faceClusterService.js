/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类服务 - 调用 Python API 并处理聚类结果
 *
 * 📋 核心功能:
 * • 从数据库获取用户的所有人脸 embedding
 * • 调用 Python 服务的 /cluster_face_embeddings API 进行聚类
 * • 将聚类结果存储到 face_clusters 表
 * • 支持重新聚类（先删除旧数据）
 *
 * 🔄 处理流程:
 * 1. 从 face_embeddings 表获取用户的所有 embedding
 * 2. 调用 Python 服务的 /cluster_face_embeddings API
 * 3. 解析聚类结果，建立 face_embedding_id 与 cluster_id 的映射
 * 4. 删除旧的聚类数据（如果重新聚类）
 * 5. 批量插入新的聚类结果
 */

const axios = require('axios')
const logger = require('../utils/logger')
const {
  getFaceEmbeddingsByUserId,
  getOldThumbnailPathsByUserId,
  deleteFaceClustersByUserId,
  insertFaceClusters,
  getClusterStatsByUserId,
  getFaceEmbeddingsByIds,
  getMediasSharpnessByIds,
  updateFaceEmbeddingThumbnail,
  updateFaceClusterRepresentative,
  clearOtherDefaultCoverRepresentative,
  getOldClusterNameMapping,
  getOldCoverMapping,
  restoreClusterNames,
  restoreCoverSettings,
  restoreClusterDefaultCover,
  getFaceEmbeddingIdsByClusterId,
  getFaceEmbeddingRepresentativeValue,
  getRepresentativeStatusByThumbnailKeys,
  getDefaultCoverFaceEmbeddingId,
  getRepresentativeFaceEmbeddingIdsByUserId,
  computeAndUpsertClusterRepresentative,
  getUnassignedFaceEmbeddingsByUserId,
  getAllClusterRepresentativesByUserId,
  getMaxClusterIdForUser
} = require('../models/faceClusterModel')
const { getMediaStorageInfo } = require('../models/mediaModel')
const storageService = require('../services/storageService')

// Python 服务 URL（从环境变量读取）
const PYTHON_SERVICE_URL = process.env.PYTHON_FACE_SERVICE_URL || 'http://localhost:5001'

// 默认聚类阈值由 Python 服务 config.py 的 FACE_CLUSTERING_THRESHOLD 决定（余弦距离约 0.42 等）。

// 增量分配：新人脸与已有人物代表向量的最小余弦相似度（不低于此值才参与匹配，并在满足者中取最高相似度）
const INCREMENTAL_ASSIGN_MIN_SIMILARITY = Number(process.env.FACE_INCREMENTAL_ASSIGN_MIN_SIMILARITY) || 0.75

/** 余弦相似度（向量需同维） */
function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 增量分配：将未归属的人脸与已有人物代表向量比较，相似度不低于阈值者中取最高，归入该人物
 * 在 performFaceClustering 开始时调用，先分配再对剩余人脸做全量聚类
 * @param {number} userId - 用户ID
 * @returns {{ assigned: number, skipped: number }}
 */
function incrementalAssignFacesToExistingClusters(userId) {
  const representatives = getAllClusterRepresentativesByUserId(userId)
  if (representatives.length === 0) return { assigned: 0, skipped: 0 }

  const unassigned = getUnassignedFaceEmbeddingsByUserId(userId)
  if (unassigned.length === 0) return { assigned: 0, skipped: 0 }

  let assigned = 0
  for (const { id: faceEmbeddingId, embedding } of unassigned) {
    let bestClusterId = null
    let bestSim = -Infinity
    for (const { clusterId, embedding: repEmb } of representatives) {
      const sim = cosineSimilarity(embedding, repEmb)
      if (sim < INCREMENTAL_ASSIGN_MIN_SIMILARITY) continue
      if (sim > bestSim) {
        bestSim = sim
        bestClusterId = clusterId
      }
    }
    if (bestClusterId == null) continue
    try {
      insertFaceClusters(userId, [{ clusterId: bestClusterId, faceEmbeddingId, isUserAssigned: true }])
      assigned += 1
      computeAndUpsertClusterRepresentative(userId, bestClusterId)
    } catch (err) {
      logger.warn({
        message: `增量分配写入失败: faceEmbeddingId=${faceEmbeddingId}, clusterId=${bestClusterId}`,
        details: { userId, error: err.message }
      })
    }
  }
  if (assigned > 0) {
    logger.info({
      message: `增量分配: ${assigned} 张人脸归入已有人物`,
      details: { userId, assigned, skipped: unassigned.length - assigned }
    })
  }
  return { assigned, skipped: unassigned.length - assigned }
}

/**
 * 将 Python DBSCAN 结果转为待写入的 clusterData，并生成与之一致的缩略图用簇列表。
 * - 噪声点（cluster_id = -1）：每人脸单独成簇（满足「人人有簇」）
 * - 非噪声：按 Python 标签分组合并；cluster_id 使用 newClusterIdStart 起的连续新编号，避免与库内已有 cluster_id（如增量保留行）冲突
 */
function _buildClusterAssignmentsFromPython(clusters, faceEmbeddings, newClusterIdStart, userId) {
  const clusterData = []
  const clustersForThumbnails = []
  let nextId = newClusterIdStart
  const pythonLabelToNewId = new Map()
  let noiseSingletonCount = 0

  for (const cluster of clusters) {
    const clusterId = cluster.cluster_id
    const faceIndices = cluster.face_indices || []

    if (clusterId === -1) {
      for (const faceIndex of faceIndices) {
        if (faceIndex < 0 || faceIndex >= faceEmbeddings.length) {
          logger.warn({
            message: `聚类结果索引越界: faceIndex=${faceIndex}, total=${faceEmbeddings.length}`,
            details: { userId, clusterId: -1 }
          })
          continue
        }
        const assignId = nextId++
        noiseSingletonCount++
        const faceEmbedding = faceEmbeddings[faceIndex]
        clusterData.push({
          clusterId: assignId,
          faceEmbeddingId: faceEmbedding.id,
          similarityScore: null,
          isRepresentative: false
        })
        clustersForThumbnails.push({ cluster_id: assignId, face_indices: [faceIndex] })
      }
      continue
    }

    if (!pythonLabelToNewId.has(clusterId)) {
      pythonLabelToNewId.set(clusterId, nextId++)
    }
    const mappedId = pythonLabelToNewId.get(clusterId)
    const validIndices = []
    for (const faceIndex of faceIndices) {
      if (faceIndex >= 0 && faceIndex < faceEmbeddings.length) {
        const faceEmbedding = faceEmbeddings[faceIndex]
        clusterData.push({
          clusterId: mappedId,
          faceEmbeddingId: faceEmbedding.id,
          similarityScore: null,
          isRepresentative: false
        })
        validIndices.push(faceIndex)
      } else {
        logger.warn({
          message: `聚类结果索引越界: faceIndex=${faceIndex}, total=${faceEmbeddings.length}`,
          details: { userId, clusterId }
        })
      }
    }
    if (validIndices.length > 0) {
      clustersForThumbnails.push({ cluster_id: mappedId, face_indices: validIndices })
    }
  }

  if (noiseSingletonCount > 0) {
    logger.info({
      message: `DBSCAN 噪声点已拆为单人簇: ${noiseSingletonCount} 个`,
      details: { userId, noiseSingletonCount }
    })
  }

  return { clusterData, clustersForThumbnails, noiseSingletonCount }
}

/**
 * 执行人脸聚类
 * @param {Object} params - 参数对象
 * @param {number} params.userId - 用户ID
 * @param {number} [params.threshold] - 聚类阈值（可选；不传则 Python 使用配置中的默认余弦距离，见 FACE_CLUSTERING_THRESHOLD）
 * @param {boolean} [params.recluster] - 是否重新聚类（删除旧数据，默认false）
 * @returns {Object} 聚类结果统计
 */
async function performFaceClustering({ userId, threshold, recluster = false }) {
  try {
    logger.info({
      message: `开始执行人脸聚类: userId=${userId}`,
      details: { threshold, recluster }
    })

    // 0. 增量分配：未归属人脸与已有人物代表向量匹配，不低于阈值则归入相似度最高的人物
    incrementalAssignFacesToExistingClusters(userId)

    // 1. 获取用户的所有人脸 embedding（自动排除已经在手动聚类中的记录）
    const faceEmbeddings = getFaceEmbeddingsByUserId(userId)

    if (!faceEmbeddings || faceEmbeddings.length === 0) {
      logger.info({
        message: `用户 ${userId} 没有可聚类的人脸数据`
      })
      return {
        success: true,
        clusterCount: 0,
        totalFaces: 0,
        message: '没有可聚类的人脸数据'
      }
    }

    logger.info({
      message: `获取到 ${faceEmbeddings.length} 个人脸 embedding（已自动排除手动聚类的记录）`,
      details: { userId }
    })

    // 2. 准备调用 Python API 的数据
    const embeddings = faceEmbeddings.map((fe) => fe.embedding)
    // 如果提供了自定义阈值，则使用；否则不传递 threshold，让 Python 使用配置文件的默认值
    const requestBody = {
      embeddings: embeddings
    }

    // 只有在明确提供了 threshold 时才传递（允许覆盖配置文件的默认值）
    if (threshold !== undefined && threshold !== null) {
      requestBody.threshold = threshold
    }

    // 3. 检查 Python 服务是否可用
    try {
      const healthCheck = await axios.get(`${PYTHON_SERVICE_URL}/health`, {
        timeout: 30000 // 30秒（enhanced 档启动/加载大模型时可能较慢）
      })
      if (!healthCheck.data?.status || healthCheck.data.status !== 'healthy') {
        throw new Error(`Python 服务健康检查失败: ${JSON.stringify(healthCheck.data)}`)
      }
      logger.info({
        message: `Python 服务健康检查通过`,
        details: { serviceUrl: PYTHON_SERVICE_URL }
      })
    } catch (error) {
      const errorMsg =
        error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT'
          ? `无法连接到 Python 服务 (${PYTHON_SERVICE_URL})。请确保服务正在运行。\n提示: 可以运行 "cd python-ai-service && python3 start.py" 启动服务`
          : `Python 服务健康检查失败: ${error.message}`
      logger.error({
        message: errorMsg,
        details: {
          serviceUrl: PYTHON_SERVICE_URL,
          error: error.message,
          code: error.code
        }
      })
      throw new Error(errorMsg)
    }

    // 4. 调用 Python 服务的聚类 API
    logger.info({
      message: `调用 Python 聚类服务: ${PYTHON_SERVICE_URL}/cluster_face_embeddings`,
      details: {
        embeddingCount: embeddings.length,
        threshold: threshold !== undefined && threshold !== null ? threshold : '使用配置文件默认值'
      }
    })

    let response
    try {
      response = await axios.post(`${PYTHON_SERVICE_URL}/cluster_face_embeddings`, requestBody, {
        timeout: 300000, // 5分钟超时（大量数据可能需要较长时间）
        headers: {
          'Content-Type': 'application/json'
        }
      })
    } catch (error) {
      // 提供更详细的错误信息
      if (error.code === 'ECONNREFUSED') {
        throw new Error(
          `无法连接到 Python 服务 (${PYTHON_SERVICE_URL})。请确保服务正在运行。\n提示: 可以运行 "cd python-ai-service && python3 start.py" 启动服务`
        )
      } else if (error.code === 'ETIMEDOUT') {
        throw new Error(`Python 服务请求超时 (${PYTHON_SERVICE_URL})。可能是数据量太大或服务响应慢。`)
      } else if (error.response) {
        // Python 服务返回了错误响应
        const status = error.response.status
        const detail = error.response.data?.detail || error.response.data?.message || error.message
        throw new Error(`Python 聚类服务错误 (${status}): ${detail}`)
      } else {
        throw new Error(`调用 Python 聚类服务失败: ${error.message}`)
      }
    }

    const clusters = response.data.clusters || []

    if (!clusters || clusters.length === 0) {
      logger.warn({
        message: `Python 服务返回空聚类结果`,
        details: { userId, embeddingCount: embeddings.length }
      })
      return {
        success: true,
        clusterCount: 0,
        totalFaces: 0,
        message: '聚类结果为空'
      }
    }

    logger.info({
      message: `Python 服务返回 ${clusters.length} 个聚类`,
      details: {
        userId,
        clusterCount: clusters.length,
        totalFaces: embeddings.length
      }
    })

    // 5. 若重新聚类：先备份清理所需的映射并删除自动聚类行（保留手动/增量分配）
    let oldThumbnailPaths = []
    let oldClusterNameMapping = null
    let oldCoverMapping = null
    if (recluster) {
      oldThumbnailPaths = getOldThumbnailPathsByUserId(userId)
      logger.info({
        message: `找到 ${oldThumbnailPaths.length} 个旧缩略图文件`,
        details: { userId }
      })

      // 保存旧的聚类名称映射（在删除前）
      oldClusterNameMapping = getOldClusterNameMapping(userId)
      logger.info({
        message: `找到 ${oldClusterNameMapping.size} 个有名称的旧聚类`,
        details: { userId }
      })

      // 保存旧的封面设置映射（在删除前）
      oldCoverMapping = getOldCoverMapping(userId)
      logger.info({
        message: `找到 ${oldCoverMapping.size} 个手动设置的封面`,
        details: { userId }
      })

      // 删除旧的聚类数据（排除用户手动分配的记录，保护用户的手动调整）
      const deleteResult = deleteFaceClustersByUserId(userId, { excludeUserAssigned: true })
      logger.info({
        message: `删除旧聚类数据: ${deleteResult.affectedRows} 条（已排除用户手动分配的记录）`,
        details: { userId }
      })
    }

    // 6. 解析 Python 结果为 clusterData（人人有簇：DBSCAN 噪声 -1 拆为单人簇；cluster_id 自 MAX+1 起分配，避免与保留行冲突）
    const nextClusterIdStart = getMaxClusterIdForUser(userId) + 1
    const { clusterData, clustersForThumbnails, noiseSingletonCount } = _buildClusterAssignmentsFromPython(
      clusters,
      faceEmbeddings,
      nextClusterIdStart,
      userId
    )

    logger.info({
      message: `解析完成，准备插入 ${clusterData.length} 条聚类数据`,
      details: {
        userId,
        nextClusterIdStart,
        pythonClusterGroupCount: clusters.length,
        noiseSingletonClusters: noiseSingletonCount
      }
    })

    // 7. 批量插入聚类结果
    const insertResult = insertFaceClusters(userId, clusterData)

    // 7.5 为每个新 cluster 计算并写入代表向量（用于后续增量匹配）
    const distinctClusterIds = [...new Set(clusterData.map((d) => d.clusterId))]
    for (const cid of distinctClusterIds) {
      computeAndUpsertClusterRepresentative(userId, cid)
    }

    // 8. 如果重新聚类，尝试恢复聚类名称和封面设置
    if (recluster) {
      // 8.1 恢复聚类名称（根据新旧聚类的 face_embedding_id 重叠度匹配）
      // 使用一对一匹配策略，确保每个名称只分配给一个最匹配的新聚类
      if (oldClusterNameMapping && oldClusterNameMapping.size > 0) {
        const restoredCount = restoreClusterNames(userId, oldClusterNameMapping, clusterData, 0.6)
        logger.info({
          message: `恢复了 ${restoredCount} 个聚类的自定义名称（使用一对一匹配策略）`,
          details: { userId, totalOldNamedClusters: oldClusterNameMapping.size }
        })
      }

      // 8.2 恢复封面设置（根据 face_embedding_id 直接匹配）
      // 注意：缩略图的生成和验证会移到步骤 9.1，这里只恢复封面标志
      if (oldCoverMapping && oldCoverMapping.size > 0) {
        // 过滤出在新聚类中存在的 face_embedding_id
        const validCoverMapping = new Map()
        for (const [faceEmbeddingId, oldClusterId] of oldCoverMapping.entries()) {
          const existsInNewCluster = clusterData.some((item) => item.faceEmbeddingId === faceEmbeddingId)
          if (existsInNewCluster) {
            validCoverMapping.set(faceEmbeddingId, oldClusterId)
          } else {
            logger.warn({
              message: `无法恢复封面设置: face_embedding_id=${faceEmbeddingId} 在新聚类中不存在`,
              details: { userId, faceEmbeddingId, oldClusterId }
            })
          }
        }

        // 恢复封面设置（缩略图会在步骤 9.1 中生成和验证）
        if (validCoverMapping.size > 0) {
          const restoredCoverCount = restoreCoverSettings(userId, validCoverMapping, clusterData)
          logger.info({
            message: `恢复了 ${restoredCoverCount} 个手动设置的封面标志（共 ${oldCoverMapping.size} 个，${oldCoverMapping.size - validCoverMapping.size} 个因不在新聚类中被跳过）`,
            details: { userId, totalOldCovers: oldCoverMapping.size, validCovers: validCoverMapping.size }
          })
        } else {
          logger.warn({
            message: `没有可恢复的封面（所有封面都不在新聚类中）`,
            details: { userId, totalOldCovers: oldCoverMapping.size }
          })
        }
      }
    }

    logger.info({
      message: `✅ 人脸聚类完成`,
      details: {
        userId,
        distinctClusterCount: new Set(clusterData.map((d) => d.clusterId)).size,
        insertedRows: insertResult.affectedRows,
        totalFaces: faceEmbeddings.length
      }
    })

    // 9. 为每个cluster选择最佳人脸并生成缩略图（默认封面）（使用已偏移的 cluster_id，与入库一致）
    const generatedThumbnailPaths = await _generateThumbnailsForClusters(userId, clustersForThumbnails, faceEmbeddings)

    // 9.0 聚类触发后同步自愈当前封面缩略图（仅在聚类流程触发，不影响日常列表接口）
    // - 目标：处理「数据库有 key 但磁盘文件丢失」场景
    // - 行为：对默认/手动封面的 faceEmbedding 调用 generateThumbnailForFaceEmbedding(..., false)
    //   若文件存在会快速返回；若缺失则同步重建
    const coverCheckStats = await _ensureRepresentativeCoverThumbnails(userId)
    if (coverCheckStats.regenerated > 0 || coverCheckStats.failed > 0) {
      logger.info({
        message: `聚类后封面缩略图自愈完成`,
        details: {
          userId,
          checked: coverCheckStats.checked,
          regenerated: coverCheckStats.regenerated,
          failed: coverCheckStats.failed
        }
      })
    }

    // 9.1. 如果重新聚类，为手动设置的封面（representative_type = 2）验证并生成缩略图（如果文件不存在）
    if (recluster && oldCoverMapping && oldCoverMapping.size > 0) {
      // 获取所有手动设置封面的 face_embedding_id
      const manualCoverFaceIds = Array.from(oldCoverMapping.keys())

      // 批量查询这些 face_embedding 的缩略图存储键
      const faceEmbeddings = getFaceEmbeddingsByIds(manualCoverFaceIds)

      // 验证并生成缺失的缩略图
      let regeneratedCount = 0
      for (const faceEmbedding of faceEmbeddings) {
        if (faceEmbedding.face_thumbnail_storage_key) {
          try {
            // 验证文件是否存在，如果不存在则重新生成
            const thumbnailKey = await generateThumbnailForFaceEmbedding(faceEmbedding.id, false)
            if (thumbnailKey && thumbnailKey !== faceEmbedding.face_thumbnail_storage_key) {
              regeneratedCount++
            }
          } catch (error) {
            logger.warn({
              message: `验证/生成手动封面缩略图失败: faceEmbeddingId=${faceEmbedding.id}`,
              details: { userId, faceEmbeddingId: faceEmbedding.id, error: error.message }
            })
          }
        }
      }

      if (regeneratedCount > 0) {
        logger.info({
          message: `为手动设置的封面重新生成了 ${regeneratedCount} 个缩略图`,
          details: { userId }
        })
      }
    }

    // 10. 如果重新聚类，清理不再使用的旧缩略图
    if (recluster && oldThumbnailPaths.length > 0) {
      // 查询旧缩略图对应的 representative_type 状态
      const representativeStatusMap = getRepresentativeStatusByThumbnailKeys(userId, oldThumbnailPaths)

      // 新生成的默认封面缩略图集合（用于快速查找）
      const newThumbnailPathsSet = new Set(generatedThumbnailPaths)

      // 确定哪些缩略图需要删除：
      // 1. 在新生成的默认封面列表中 -> 保留（已在使用）
      // 2. representative_type = 1/2（默认封面或手动封面）-> 保留
      //    说明：重聚类后默认封面可能沿用旧 key（未重新生成），必须保留，避免误删导致人物无封面
      // 3. 其他 -> 删除
      const thumbnailsToDelete = oldThumbnailPaths.filter((path) => {
        // 如果在新生成的默认封面列表中，保留
        if (newThumbnailPathsSet.has(path)) {
          return false
        }

        // 如果 representative_type = 1/2（默认封面/手动封面），保留
        const isRepresentative = representativeStatusMap.get(path)
        if (isRepresentative === 1 || isRepresentative === 2) {
          return false
        }

        // 其他情况，删除
        return true
      })

      if (thumbnailsToDelete.length > 0) {
        logger.info({
          message: `开始清理 ${thumbnailsToDelete.length} 个不再使用的缩略图文件（另有 ${oldThumbnailPaths.length - thumbnailsToDelete.length} 个旧路径因仍被引用而保留，含手动封面与新默认封面）`,
          details: {
            userId,
            totalOld: oldThumbnailPaths.length,
            toDelete: thumbnailsToDelete.length,
            preserved: oldThumbnailPaths.length - thumbnailsToDelete.length,
            newDefaultCovers: generatedThumbnailPaths.length
          }
        })

        let deletedCount = 0
        let failedCount = 0
        for (const thumbnailPath of thumbnailsToDelete) {
          try {
            await storageService.storage.deleteFile(thumbnailPath)
            deletedCount++
          } catch (error) {
            failedCount++
            // 如果文件不存在，不算错误（可能已经被删除）
            if (error.code !== 'ENOENT' && error.status !== 404) {
              logger.warn({
                message: `删除不再使用的缩略图失败: ${thumbnailPath}`,
                details: { userId, error: error.message }
              })
            }
          }
        }
        logger.info({
          message: `清理不再使用的缩略图完成: 成功 ${deletedCount} 个，失败 ${failedCount} 个`,
          details: { userId, total: thumbnailsToDelete.length }
        })
      } else {
        logger.info({
          message: `所有旧缩略图仍在使用中或为手动设置的封面，无需清理`,
          details: { userId, totalOld: oldThumbnailPaths.length }
        })
      }
    }

    // 11. 获取聚类统计信息
    const stats = getClusterStatsByUserId(userId)

    return {
      success: true,
      clusterCount: stats.clusterCount,
      totalFaces: stats.totalFaces,
      uniqueFaceCount: stats.uniqueFaceCount,
      message: '聚类完成'
    }
  } catch (error) {
    logger.error({
      message: `人脸聚类失败: userId=${userId}`,
      details: {
        error: error.message,
        stack: error.stack,
        userId,
        threshold
      }
    })

    // 错误已经在 try-catch 中处理，这里只需要重新抛出
    throw error
  }
}

/**
 * 聚类后检查当前封面（representative_type=1/2）缩略图是否缺失，缺失则同步重建
 * @param {number} userId - 用户ID
 * @returns {Promise<{checked:number, regenerated:number, failed:number}>}
 */
async function _ensureRepresentativeCoverThumbnails(userId) {
  const faceEmbeddingIds = getRepresentativeFaceEmbeddingIdsByUserId(userId)
  let regenerated = 0
  let failed = 0

  for (const faceEmbeddingId of faceEmbeddingIds) {
    try {
      const before = getFaceEmbeddingsByIds([faceEmbeddingId])[0]?.face_thumbnail_storage_key ?? null
      const after = await generateThumbnailForFaceEmbedding(faceEmbeddingId, false)
      if (!after) {
        failed++
        continue
      }
      if (before == null || before !== after) {
        regenerated++
      }
    } catch (error) {
      failed++
      logger.warn({
        message: `聚类后封面缩略图自愈失败: faceEmbeddingId=${faceEmbeddingId}`,
        details: { userId, faceEmbeddingId, error: error.message }
      })
    }
  }

  return {
    checked: faceEmbeddingIds.length,
    regenerated,
    failed
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
  let successCount = 0
  let failCount = 0
  const MAX_ERRORS = 5 // 最大错误数，达到后停止处理
  const generatedThumbnailPaths = [] // 记录生成的缩略图路径

  for (const cluster of clusters) {
    const clusterId = cluster.cluster_id
    const faceIndices = cluster.face_indices || []

    if (clusterId === -1 || faceIndices.length === 0) {
      continue // 跳过噪声点
    }

    try {
      // 1. 获取该cluster的所有人脸数据（需要包含完整信息）
      const clusterFaceIds = faceIndices.map((index) => faceEmbeddings[index]?.id).filter((id) => id != null)

      if (clusterFaceIds.length === 0) {
        continue
      }

      // 2. 从数据库获取完整的人脸信息（包括quality_score、bbox、pose等）
      const clusterFaces = getFaceEmbeddingsByIds(clusterFaceIds)

      if (clusterFaces.length === 0) {
        continue
      }

      // 3. 构建图片清晰度映射 + 媒体类型（优先在图片上选封面、再尝试裁剪）
      const imageIds = [...new Set(clusterFaces.map((f) => f.image_id))]
      const imagesMap = getMediasSharpnessByIds(imageIds)
      const mediaTypeByImageId = new Map()
      for (const iid of imageIds) {
        const info = getMediaStorageInfo(iid)
        mediaTypeByImageId.set(iid, info?.mediaType || 'image')
      }

      const ranked = _rankFacesForCover(clusterFaces, imagesMap, mediaTypeByImageId)
      if (ranked.length === 0) {
        logger.warn({
          message: `未找到最佳人脸: clusterId=${clusterId}`,
          details: { userId, clusterId, faceCount: clusterFaces.length }
        })
        continue
      }

      let bestFace = null
      let bbox = null
      for (const face of ranked) {
        if (mediaTypeByImageId.get(face.image_id) === 'video') continue
        const nb = _normalizeBboxFromFace(face)
        if (nb) {
          bestFace = face
          bbox = nb
          break
        }
      }

      if (!bestFace) {
        const repFace = ranked.find((f) => mediaTypeByImageId.get(f.image_id) !== 'video') || ranked[0]
        clearOtherDefaultCoverRepresentative(userId, clusterId, repFace.id)
        updateFaceClusterRepresentative(userId, clusterId, repFace.id)
        logger.info({
          message: `簇内无人脸小图可用（视频或 bbox 无效），已标记默认封面，列表使用整图缩略图`,
          details: { userId, clusterId, faceEmbeddingId: repFace.id }
        })
        continue
      }

      // 4. 获取图片数据（bestFace 已保证为图片媒体且 bbox 合法）
      const imageInfo = getMediaStorageInfo(bestFace.image_id)
      if (!imageInfo) {
        logger.warn({
          message: `图片不存在: imageId=${bestFace.image_id}`,
          details: { userId, clusterId }
        })
        continue
      }

      let imageData = null
      const storageKey = imageInfo.highResStorageKey || imageInfo.originalStorageKey

      if (storageKey) {
        try {
          imageData = await storageService.storage.getFileBuffer(storageKey)
        } catch (error) {
          logger.error({
            message: `获取图片数据失败: storageKey=${storageKey}`,
            details: { error: error.message, userId, clusterId }
          })
          continue
        }
      }

      if (!imageData) {
        logger.warn({
          message: `无法获取图片数据: imageId=${bestFace.image_id}`,
          details: { userId, clusterId }
        })
        continue
      }

      // 5. 调用 Python 裁剪人脸缩略图（bbox 已在上方解析）
      if (!imageData || !Buffer.isBuffer(imageData)) {
        logger.error({
          message: `图片数据格式错误: clusterId=${clusterId}`,
          details: { userId, clusterId, imageId: bestFace.image_id }
        })
        continue
      }

      const FormData = require('form-data')
      const formData = new FormData()
      formData.append('image', imageData, 'image.jpg')
      // bbox需要作为Form字段传递（Python API期望Form参数）
      const bboxString = JSON.stringify(bbox)
      formData.append('bbox', bboxString)

      let response
      try {
        response = await axios.post(`${PYTHON_SERVICE_URL}/crop_face_thumbnail`, formData, {
          headers: formData.getHeaders(),
          timeout: 30000 // 30秒超时
        })
      } catch (error) {
        failCount++
        logger.error({
          message: `调用Python服务生成缩略图失败: clusterId=${clusterId} (错误${failCount}/${MAX_ERRORS})`,
          details: {
            error: error.message,
            status: error.response?.status,
            userId,
            clusterId,
            imageId: bestFace.image_id
          }
        })

        // 如果错误达到上限，停止处理并抛出错误
        if (failCount >= MAX_ERRORS) {
          const errorMsg = `错误数量达到上限(${MAX_ERRORS})，停止生成缩略图`
          logger.error({
            message: errorMsg,
            details: {
              userId,
              successCount,
              failCount,
              totalClusters: clusters.length
            }
          })
          throw new Error(errorMsg) // 抛出错误，让调用方知道
        }

        continue // 继续处理下一个cluster
      }

      const thumbnailBase64 = response.data.face_thumbnail_base64

      if (!thumbnailBase64) {
        logger.warn({
          message: `Python服务未返回缩略图: clusterId=${clusterId}`,
          details: { userId, clusterId }
        })
        continue
      }

      // 8. 存储缩略图
      const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '')
      const imageBuffer = Buffer.from(base64Data, 'base64')
      const thumbnailStorageKey = `storage-local/face-thumbnails/${bestFace.image_id}-${bestFace.face_index}.jpg`

      await storageService.storage.storeFile(imageBuffer, thumbnailStorageKey, {
        contentType: 'image/jpeg'
      })

      // 记录生成的缩略图路径
      generatedThumbnailPaths.push(thumbnailStorageKey)

      // 9. 更新face_embeddings表，设置face_thumbnail_storage_key
      updateFaceEmbeddingThumbnail(bestFace.id, thumbnailStorageKey)

      // 10. 更新face_clusters：先清除同簇其他「默认封面」(1)，避免列表封面 SQL 按 similarity_score 选到
      // 旧默认人脸（其缩略图可能已在清理步骤中删除），再标记当前最佳人脸为代表
      clearOtherDefaultCoverRepresentative(userId, clusterId, bestFace.id)
      updateFaceClusterRepresentative(userId, clusterId, bestFace.id)

      successCount++
      logger.info({
        message: `✅ 已为cluster生成缩略图: clusterId=${clusterId}`,
        details: { userId, clusterId, faceEmbeddingId: bestFace.id }
      })
    } catch (error) {
      logger.error({
        message: `生成缩略图失败: clusterId=${clusterId}`,
        details: {
          error: error.message,
          stack: error.stack,
          userId,
          clusterId
        }
      })
      // 继续处理下一个cluster，不中断流程
    }
  }

  // 返回生成的缩略图路径列表
  return generatedThumbnailPaths
}

/** @returns {number[]|null} 合法 bbox 数组或 null */
function _normalizeBboxFromFace(face) {
  let bbox = face.bbox
  if (typeof bbox === 'string' && bbox.trim()) {
    try {
      bbox = JSON.parse(bbox)
    } catch {
      return null
    }
  }
  if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
    return null
  }
  return bbox
}

/**
 * 按封面策略排序人脸（前者更优）。可选 mediaTypeByImageId：优先图片媒体，其次视频帧人脸。
 *
 * @param {Map} [mediaTypeByImageId] - image_id -> 'image'|'video'
 * @returns {Array} 已排序人脸列表（可能为空）
 */
function _rankFacesForCover(faces, imagesMap = new Map(), mediaTypeByImageId = null) {
  if (!faces || faces.length === 0) {
    return []
  }

  const facesWithMetrics = faces.map((face) => {
    let bbox = face.bbox
    let pose = face.pose

    // 解析bbox（如果是JSON字符串）
    if (typeof bbox === 'string' && bbox.trim()) {
      try {
        bbox = JSON.parse(bbox)
      } catch {
        // JSON解析失败，设置为null
        bbox = null
      }
    }
    // 解析pose（如果是JSON字符串）
    if (typeof pose === 'string' && pose.trim()) {
      try {
        pose = JSON.parse(pose)
      } catch {
        // JSON解析失败，设置为null
        pose = null
      }
    }

    // 计算bbox面积
    const bboxArea = bbox && bbox.length === 4 ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : 0

    // 计算pose得分（yaw和pitch的绝对值越小越好）
    const yaw = pose?.yaw || 0
    const pitch = pose?.pitch || 0
    let poseScore = 1.0 - (Math.abs(yaw) / 90.0 + Math.abs(pitch) / 90.0) / 2.0
    poseScore = Math.max(0.0, poseScore) // 确保不为负数

    // 表情优先级（happy > neutral > 其他）
    const expressionPriority = {
      happy: 2,
      neutral: 1
    }
    const expressionScore = expressionPriority[face.expression] || 0

    // 清晰度（通过JOIN images表获取）
    const imageInfo = imagesMap.get(face.image_id)
    const sharpnessScore = imageInfo?.sharpness_score || 0

    return {
      ...face,
      bbox,
      pose,
      bboxArea,
      poseScore,
      qualityScore: face.quality_score || 0,
      expressionScore,
      sharpnessScore
    }
  })

  facesWithMetrics.sort((a, b) => {
    if (mediaTypeByImageId) {
      const aV = mediaTypeByImageId.get(a.image_id) === 'video' ? 1 : 0
      const bV = mediaTypeByImageId.get(b.image_id) === 'video' ? 1 : 0
      if (aV !== bV) return aV - bV
    }

    // 第一优先级：表情分桶（happy > neutral > 其他）
    if (a.expressionScore !== b.expressionScore) {
      return b.expressionScore - a.expressionScore
    }

    // 第二优先级：quality_score（基础质量）
    if (Math.abs(a.qualityScore - b.qualityScore) > 0.05) {
      return b.qualityScore - a.qualityScore
    }

    // 第三优先级：pose得分（越正面越好）
    if (Math.abs(a.poseScore - b.poseScore) > 0.05) {
      return b.poseScore - a.poseScore
    }

    // 第四优先级：bbox面积（大脸优先）
    if (Math.abs(a.bboxArea - b.bboxArea) > 1000) {
      return b.bboxArea - a.bboxArea
    }

    // 第五优先级：清晰度
    if (Math.abs(a.sharpnessScore - b.sharpnessScore) > 0.05) {
      return b.sharpnessScore - a.sharpnessScore
    }

    // 都相同，按时间排序（最新的优先）
    return (b.image_created_at || 0) - (a.image_created_at || 0)
  })

  return facesWithMetrics
}

/**
 * 获取用户的聚类统计信息
 * @param {number} userId - 用户ID
 * @returns {Object} 聚类统计信息
 */
function getFaceClusterStats(userId) {
  return getClusterStatsByUserId(userId)
}

/**
 * 簇内没有 representative_type=1 时（例如重聚类只恢复了手动封面 2、或缩略图步骤未写入默认行），按封面策略补选一人并标记为默认封面。
 * @returns {Promise<number|null>} face_embedding_id
 */
async function _ensureDefaultCoverRepresentative(userId, clusterId) {
  const ids = getFaceEmbeddingIdsByClusterId(userId, clusterId)
  if (!ids || ids.length === 0) return null

  const faces = getFaceEmbeddingsByIds(ids)
  if (faces.length === 0) return null

  const imageIds = [...new Set(faces.map((f) => f.image_id))]
  const imagesMap = getMediasSharpnessByIds(imageIds)
  const mediaTypeByImageId = new Map()
  for (const iid of imageIds) {
    const info = getMediaStorageInfo(iid)
    mediaTypeByImageId.set(iid, info?.mediaType || 'image')
  }

  const ranked = _rankFacesForCover(faces, imagesMap, mediaTypeByImageId)
  if (ranked.length === 0) return null

  let pickId = null
  for (const f of ranked) {
    const v = getFaceEmbeddingRepresentativeValue(userId, clusterId, f.id)
    if (v !== 2) {
      pickId = f.id
      break
    }
  }
  if (pickId == null) {
    pickId = ranked[0].id
  }

  clearOtherDefaultCoverRepresentative(userId, clusterId, pickId)
  updateFaceClusterRepresentative(userId, clusterId, pickId, 1)
  await generateThumbnailForFaceEmbedding(pickId, false)

  logger.info({
    message: `已补写默认封面行（原无 representative_type=1）: clusterId=${clusterId}`,
    details: { userId, clusterId, faceEmbeddingId: pickId }
  })

  return pickId
}

/**
 * 恢复聚类默认封面：清除手动设置的封面（representative_type = 2），恢复默认封面（representative_type = 1）
 * @param {number} userId - 用户ID
 * @param {number} clusterId - 聚类ID
 * @returns {Promise<Object>} 返回 { faceEmbeddingId, thumbnailStorageKey } 或 null
 */
async function restoreDefaultCover(userId, clusterId) {
  try {
    // 1. 获取默认封面 face_embedding_id（representative_type = 1）
    let defaultFaceEmbeddingId = getDefaultCoverFaceEmbeddingId(userId, clusterId)

    if (!defaultFaceEmbeddingId) {
      defaultFaceEmbeddingId = await _ensureDefaultCoverRepresentative(userId, clusterId)
    }

    if (!defaultFaceEmbeddingId) {
      logger.warn({
        message: `无法找到或补写默认封面: clusterId=${clusterId}`,
        details: { userId, clusterId }
      })
      return null
    }

    // 2. 验证该 face_embedding 是否存在且有效
    const faceEmbeddings = getFaceEmbeddingsByIds([defaultFaceEmbeddingId])
    if (faceEmbeddings.length === 0) {
      logger.warn({
        message: `默认封面对应的 face_embedding 不存在: faceEmbeddingId=${defaultFaceEmbeddingId}`,
        details: { userId, clusterId }
      })
      return null
    }

    const defaultFace = faceEmbeddings[0]

    // 3. 确保有缩略图（如果还没有，生成一个）
    let thumbnailStorageKey = defaultFace.face_thumbnail_storage_key
    if (!thumbnailStorageKey) {
      thumbnailStorageKey = await generateThumbnailForFaceEmbedding(defaultFaceEmbeddingId)
      if (!thumbnailStorageKey) {
        logger.warn({
          message: `生成缩略图失败，但继续设置封面: faceEmbeddingId=${defaultFaceEmbeddingId}`,
          details: { userId, clusterId }
        })
      }
    }

    // 4. 恢复默认封面：清除手动设置的封面（representative_type = 2），确保默认封面（representative_type = 1）存在
    const result = restoreClusterDefaultCover(userId, clusterId, defaultFaceEmbeddingId)

    if (result.error || result.affectedRows === 0) {
      logger.error({
        message: `恢复默认封面失败: clusterId=${clusterId}`,
        details: { userId, clusterId, faceEmbeddingId: defaultFaceEmbeddingId, error: result.error }
      })
      return null
    }

    logger.info({
      message: `✅ 已恢复默认封面: clusterId=${clusterId}`,
      details: { userId, clusterId, faceEmbeddingId: defaultFaceEmbeddingId }
    })

    return {
      faceEmbeddingId: defaultFaceEmbeddingId,
      thumbnailStorageKey
    }
  } catch (error) {
    logger.error({
      message: `恢复默认封面失败: clusterId=${clusterId}`,
      details: {
        error: error.message,
        stack: error.stack,
        userId,
        clusterId
      }
    })
    throw error
  }
}

/**
 * 为单个 face_embedding 生成缩略图（如果还没有）
 * @param {number} faceEmbeddingId - face_embedding ID
 * @param {boolean} forceRegenerate - 是否强制重新生成（即使已有缩略图），默认 false
 * @returns {Promise<string|null>} 返回缩略图存储键，如果生成失败则返回 null
 */
async function generateThumbnailForFaceEmbedding(faceEmbeddingId, forceRegenerate = false) {
  try {
    // 1. 获取 face_embedding 信息
    const faceEmbeddings = getFaceEmbeddingsByIds([faceEmbeddingId])
    if (faceEmbeddings.length === 0) {
      logger.warn({
        message: `face_embedding 不存在: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    const faceEmbedding = faceEmbeddings[0]

    // 2. 检查是否已有缩略图（如果不需要强制重新生成）
    if (faceEmbedding.face_thumbnail_storage_key && !forceRegenerate) {
      // 验证文件是否真的存在
      try {
        const fileExists = await storageService.storage.fileExists(faceEmbedding.face_thumbnail_storage_key)
        if (fileExists) {
          return faceEmbedding.face_thumbnail_storage_key
        } else {
          // 文件不存在，需要重新生成
          logger.warn({
            message: `缩略图文件不存在，将重新生成: faceEmbeddingId=${faceEmbeddingId}, storageKey=${faceEmbedding.face_thumbnail_storage_key}`
          })
        }
      } catch (error) {
        // 验证文件失败，继续重新生成
        logger.warn({
          message: `验证缩略图文件失败，将重新生成: faceEmbeddingId=${faceEmbeddingId}`,
          details: { error: error.message }
        })
      }
    }

    // 3. 获取图片数据（封面仅支持图片，视频人脸只参与聚类，不生成缩略图）
    const imageInfo = getMediaStorageInfo(faceEmbedding.image_id)
    if (!imageInfo) {
      logger.warn({
        message: `图片不存在: imageId=${faceEmbedding.image_id}`,
        details: { faceEmbeddingId }
      })
      return null
    }

    if (imageInfo.mediaType && imageInfo.mediaType !== 'image') {
      logger.warn({
        message: `跳过非图片媒体的聚类封面缩略图生成`,
        details: { faceEmbeddingId, imageId: faceEmbedding.image_id, mediaType: imageInfo.mediaType }
      })
      return null
    }

    // 4. 获取图片buffer（优先高清图）
    let imageData = null
    let storageKey = imageInfo.highResStorageKey || imageInfo.originalStorageKey

    if (storageKey) {
      try {
        imageData = await storageService.storage.getFileBuffer(storageKey)
      } catch (error) {
        logger.error({
          message: `获取图片数据失败: storageKey=${storageKey}`,
          details: { error: error.message, faceEmbeddingId }
        })
        return null
      }
    }

    if (!imageData) {
      logger.warn({
        message: `无法获取图片数据: imageId=${faceEmbedding.image_id}`,
        details: { faceEmbeddingId }
      })
      return null
    }

    // 5. 准备 bbox
    let bbox = faceEmbedding.bbox
    if (typeof bbox === 'string') {
      try {
        bbox = JSON.parse(bbox)
      } catch {
        logger.error({
          message: `bbox JSON解析失败: faceEmbeddingId=${faceEmbeddingId}`
        })
        return null
      }
    }

    // 检查bbox格式
    if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
      logger.warn({
        message: `bbox格式无效: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    if (!imageData || !Buffer.isBuffer(imageData)) {
      logger.error({
        message: `图片数据格式错误: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    // 6. 调用Python服务生成缩略图
    const FormData = require('form-data')
    const formData = new FormData()
    formData.append('image', imageData, 'image.jpg')
    const bboxString = JSON.stringify(bbox)
    formData.append('bbox', bboxString)

    let response
    try {
      response = await axios.post(`${PYTHON_SERVICE_URL}/crop_face_thumbnail`, formData, {
        headers: formData.getHeaders(),
        timeout: 30000 // 30秒超时
      })
    } catch (error) {
      logger.error({
        message: `调用Python服务生成缩略图失败: faceEmbeddingId=${faceEmbeddingId}`,
        details: {
          error: error.message,
          status: error.response?.status
        }
      })
      return null
    }

    const thumbnailBase64 = response.data.face_thumbnail_base64

    if (!thumbnailBase64) {
      logger.warn({
        message: `Python服务未返回缩略图: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    // 7. 存储缩略图
    const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '')
    const imageBuffer = Buffer.from(base64Data, 'base64')
    const thumbnailStorageKey = `storage-local/face-thumbnails/${faceEmbedding.image_id}-${faceEmbedding.face_index}.jpg`

    await storageService.storage.storeFile(imageBuffer, thumbnailStorageKey, {
      contentType: 'image/jpeg'
    })

    // 8. 更新face_embeddings表，设置face_thumbnail_storage_key
    updateFaceEmbeddingThumbnail(faceEmbeddingId, thumbnailStorageKey)

    logger.info({
      message: `✅ 已为face_embedding生成缩略图: faceEmbeddingId=${faceEmbeddingId}`
    })

    return thumbnailStorageKey
  } catch (error) {
    logger.error({
      message: `生成缩略图失败: faceEmbeddingId=${faceEmbeddingId}`,
      details: {
        error: error.message,
        stack: error.stack
      }
    })
    return null
  }
}

module.exports = {
  performFaceClustering,
  getFaceClusterStats,
  generateThumbnailForFaceEmbedding,
  restoreDefaultCover
}
