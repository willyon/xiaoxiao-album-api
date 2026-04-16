/**
 * 人脸聚类编排层：负责增量分配、调用 Python 聚类、落库、恢复名称封面与后处理清理。
 */
const logger = require('../../utils/logger')
const {
  getFaceEmbeddingsByUserId,
  getOldThumbnailPathsByUserId,
  deleteFaceClustersByUserId,
  insertFaceClusters,
  getClusterStatsByUserId,
  getFaceEmbeddingsByIds,
  getOldClusterNameMapping,
  getOldCoverMapping,
  restoreClusterNames,
  restoreCoverSettings,
  computeAndUpsertClusterRepresentative,
  getUnassignedFaceEmbeddingsByUserId,
  getAllClusterRepresentativesByUserId,
  getMaxClusterIdForUser
} = require('../../models/faceClusterModel')
const storageService = require('../../services/storageService')
const { checkPythonServiceHealth, clusterFaceEmbeddings } = require('./faceClusterPythonClient')
const {
  ensureRepresentativeCoverThumbnails,
  generateThumbnailsForClusters,
  generateThumbnailForFaceEmbedding,
  getRepresentativeStatusByThumbnailKeys
} = require('./faceClusterThumbnailPipeline')

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL
const INCREMENTAL_ASSIGN_MIN_SIMILARITY = Number(process.env.FACE_INCREMENTAL_ASSIGN_MIN_SIMILARITY) || 0.75

/**
 * 计算余弦相似度。
 * @param {number[]} a 向量 A
 * @param {number[]} b 向量 B
 * @returns {number} 余弦相似度
 */
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
 * 将未归属人脸增量分配给已有 cluster。
 * @param {number} userId 用户 ID
 * @returns {{assigned:number, skipped:number}}
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
 * 将 Python DBSCAN 结果映射为落库数据与缩略图输入。
 * @param {Array<{cluster_id:number, face_indices:number[]}>} clusters Python 聚类结果
 * @param {Array<{id:number}>} faceEmbeddings 人脸 embedding 列表
 * @param {number} newClusterIdStart 新簇起始 ID
 * @param {number} userId 用户 ID
 * @returns {{clusterData:any[], clustersForThumbnails:any[], noiseSingletonCount:number}}
 */
function buildClusterAssignmentsFromPython(clusters, faceEmbeddings, newClusterIdStart, userId) {
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
 * 执行人脸聚类主流程。
 * @param {{userId:number, threshold?:number, recluster?:boolean}} params 参数
 * @returns {Promise<{success:boolean, clusterCount:number, totalFaces:number, uniqueFaceCount?:number, message:string}>}
 */
async function performFaceClustering({ userId, threshold, recluster = false }) {
  try {
    logger.info({
      message: `开始执行人脸聚类: userId=${userId}`,
      details: { threshold, recluster }
    })

    incrementalAssignFacesToExistingClusters(userId)
    const faceEmbeddings = getFaceEmbeddingsByUserId(userId)

    if (!faceEmbeddings || faceEmbeddings.length === 0) {
      logger.info({ message: `用户 ${userId} 没有可聚类的人脸数据` })
      return { success: true, clusterCount: 0, totalFaces: 0, message: '没有可聚类的人脸数据' }
    }

    logger.info({
      message: `获取到 ${faceEmbeddings.length} 个人脸 embedding（已自动排除手动聚类的记录）`,
      details: { userId }
    })

    const embeddings = faceEmbeddings.map((fe) => fe.embedding)
    const requestBody = { embeddings }
    if (threshold !== undefined && threshold !== null) {
      requestBody.threshold = threshold
    }

    try {
      const healthCheckData = await checkPythonServiceHealth(PYTHON_SERVICE_URL)
      if (!healthCheckData?.status || healthCheckData.status !== 'healthy') {
        throw new Error(`Python 服务健康检查失败: ${JSON.stringify(healthCheckData)}`)
      }
      logger.info({ message: 'Python 服务健康检查通过', details: { serviceUrl: PYTHON_SERVICE_URL } })
    } catch (error) {
      const errorMsg =
        error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT'
          ? `无法连接到 Python 服务 (${PYTHON_SERVICE_URL})。请确保服务正在运行。\n提示: 可以运行 "cd python-ai-service && python3 start.py" 启动服务`
          : `Python 服务健康检查失败: ${error.message}`
      logger.error({
        message: errorMsg,
        details: { serviceUrl: PYTHON_SERVICE_URL, error: error.message, code: error.code }
      })
      throw new Error(errorMsg)
    }

    logger.info({
      message: `调用 Python 聚类服务: ${PYTHON_SERVICE_URL}/cluster_face_embeddings`,
      details: {
        embeddingCount: embeddings.length,
        threshold: threshold !== undefined && threshold !== null ? threshold : '使用配置文件默认值'
      }
    })

    let responseData
    try {
      responseData = await clusterFaceEmbeddings(PYTHON_SERVICE_URL, requestBody)
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(
          `无法连接到 Python 服务 (${PYTHON_SERVICE_URL})。请确保服务正在运行。\n提示: 可以运行 "cd python-ai-service && python3 start.py" 启动服务`
        )
      } else if (error.code === 'ETIMEDOUT') {
        throw new Error(`Python 服务请求超时 (${PYTHON_SERVICE_URL})。可能是数据量太大或服务响应慢。`)
      } else if (error.response) {
        const status = error.response.status
        const detail = error.response.data?.detail || error.response.data?.message || error.message
        throw new Error(`Python 聚类服务错误 (${status}): ${detail}`)
      } else {
        throw new Error(`调用 Python 聚类服务失败: ${error.message}`)
      }
    }

    const clusters = responseData.clusters || []
    if (!clusters || clusters.length === 0) {
      logger.warn({ message: 'Python 服务返回空聚类结果', details: { userId, embeddingCount: embeddings.length } })
      return { success: true, clusterCount: 0, totalFaces: 0, message: '聚类结果为空' }
    }

    logger.info({
      message: `Python 服务返回 ${clusters.length} 个聚类`,
      details: { userId, clusterCount: clusters.length, totalFaces: embeddings.length }
    })

    let oldThumbnailPaths = []
    let oldClusterNameMapping = null
    let oldCoverMapping = null
    if (recluster) {
      oldThumbnailPaths = getOldThumbnailPathsByUserId(userId)
      logger.info({ message: `找到 ${oldThumbnailPaths.length} 个旧缩略图文件`, details: { userId } })
      oldClusterNameMapping = getOldClusterNameMapping(userId)
      logger.info({ message: `找到 ${oldClusterNameMapping.size} 个有名称的旧聚类`, details: { userId } })
      oldCoverMapping = getOldCoverMapping(userId)
      logger.info({ message: `找到 ${oldCoverMapping.size} 个手动设置的封面`, details: { userId } })
      const deleteResult = deleteFaceClustersByUserId(userId, { excludeUserAssigned: true })
      logger.info({
        message: `删除旧聚类数据: ${deleteResult.affectedRows} 条（已排除用户手动分配的记录）`,
        details: { userId }
      })
    }

    const nextClusterIdStart = getMaxClusterIdForUser(userId) + 1
    const { clusterData, clustersForThumbnails, noiseSingletonCount } = buildClusterAssignmentsFromPython(
      clusters,
      faceEmbeddings,
      nextClusterIdStart,
      userId
    )

    logger.info({
      message: `解析完成，准备插入 ${clusterData.length} 条聚类数据`,
      details: { userId, nextClusterIdStart, pythonClusterGroupCount: clusters.length, noiseSingletonClusters: noiseSingletonCount }
    })

    const insertResult = insertFaceClusters(userId, clusterData)
    const distinctClusterIds = [...new Set(clusterData.map((d) => d.clusterId))]
    for (const cid of distinctClusterIds) {
      computeAndUpsertClusterRepresentative(userId, cid)
    }

    if (recluster) {
      if (oldClusterNameMapping && oldClusterNameMapping.size > 0) {
        const restoredCount = restoreClusterNames(userId, oldClusterNameMapping, clusterData, 0.6)
        logger.info({
          message: `恢复了 ${restoredCount} 个聚类的自定义名称（使用一对一匹配策略）`,
          details: { userId, totalOldNamedClusters: oldClusterNameMapping.size }
        })
      }
      if (oldCoverMapping && oldCoverMapping.size > 0) {
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

        if (validCoverMapping.size > 0) {
          const restoredCoverCount = restoreCoverSettings(userId, validCoverMapping, clusterData)
          logger.info({
            message: `恢复了 ${restoredCoverCount} 个手动设置的封面标志（共 ${oldCoverMapping.size} 个，${oldCoverMapping.size - validCoverMapping.size} 个因不在新聚类中被跳过）`,
            details: { userId, totalOldCovers: oldCoverMapping.size, validCovers: validCoverMapping.size }
          })
        } else {
          logger.warn({
            message: '没有可恢复的封面（所有封面都不在新聚类中）',
            details: { userId, totalOldCovers: oldCoverMapping.size }
          })
        }
      }
    }

    logger.info({
      message: '✅ 人脸聚类完成',
      details: {
        userId,
        distinctClusterCount: new Set(clusterData.map((d) => d.clusterId)).size,
        insertedRows: insertResult.affectedRows,
        totalFaces: faceEmbeddings.length
      }
    })

    const generatedThumbnailPaths = await generateThumbnailsForClusters(userId, clustersForThumbnails, faceEmbeddings)
    const coverCheckStats = await ensureRepresentativeCoverThumbnails(userId)
    if (coverCheckStats.regenerated > 0 || coverCheckStats.failed > 0) {
      logger.info({
        message: '聚类后封面缩略图自愈完成',
        details: {
          userId,
          checked: coverCheckStats.checked,
          regenerated: coverCheckStats.regenerated,
          failed: coverCheckStats.failed
        }
      })
    }

    if (recluster && oldCoverMapping && oldCoverMapping.size > 0) {
      const manualCoverFaceIds = Array.from(oldCoverMapping.keys())
      const faces = getFaceEmbeddingsByIds(manualCoverFaceIds)
      let regeneratedCount = 0
      for (const faceEmbedding of faces) {
        if (faceEmbedding.face_thumbnail_storage_key) {
          try {
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

    if (recluster && oldThumbnailPaths.length > 0) {
      const representativeStatusMap = getRepresentativeStatusByThumbnailKeys(userId, oldThumbnailPaths)
      const newThumbnailPathsSet = new Set(generatedThumbnailPaths)
      const thumbnailsToDelete = oldThumbnailPaths.filter((path) => {
        if (newThumbnailPathsSet.has(path)) return false
        const isRepresentative = representativeStatusMap.get(path)
        if (isRepresentative === 1 || isRepresentative === 2) return false
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
          message: '所有旧缩略图仍在使用中或为手动设置的封面，无需清理',
          details: { userId, totalOld: oldThumbnailPaths.length }
        })
      }
    }

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
      details: { error: error.message, stack: error.stack, userId, threshold }
    })
    throw error
  }
}

module.exports = {
  performFaceClustering
}
