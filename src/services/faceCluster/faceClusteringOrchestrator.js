/**
 * 人脸聚类编排层：Python DBSCAN、跨簇「最近脸对」合并、落库、恢复名称封面与后处理。
 * 全量重聚时不再做「先增量并标 is_user_assigned」，避免未进当次 DBSCAN 的人脸锁在子集外（同一人多簇）。
 */
const logger = require('../../utils/logger')
const {
  getFaceEmbeddingsByUserId,
  getOldThumbnailPathsByUserId,
  insertFaceClusters,
  getClusterStatsByUserId,
  getOldClusterNameMapping,
  getOldCoverMapping,
  restoreClusterNames,
  restoreCoverSettings,
  computeAndUpsertClusterRepresentative,
  getMaxClusterIdForUser
} = require('../../models/faceClusterModel')
const { clusterFaceEmbeddings } = require('./faceClusterPythonClient')
const {
  generateThumbnailsForClusters,
  handleReclusterThumbnailMaintenance
} = require('./faceClusterThumbnailPipeline')
const { mergeAutoClustersAfterDbscan } = require('./faceClusterPostMerge')

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL
/**
 * 两簇间「跨簇脸对」余弦距离**最小值** ≤ 此值则合并为同一人物；≤0 关闭。默认 0.4（略严于 Python eps 0.45）。
 */
const MERGE_MAX_MIN_PAIR_COSINE_DIST = Number(process.env.FACE_CLUSTER_MERGE_MAX_MIN_PAIR_COSINE_DISTANCE ?? 0.4)

/**
 * 将 Python DBSCAN 结果映射为落库数据与缩略图输入。
 * @param {Array<{cluster_id:number, face_indices:number[]}>} clusters - Python 聚类结果。
 * @param {Array<{id:number}>} faceEmbeddings - 人脸 embedding 列表。
 * @param {number} newClusterIdStart - 新簇起始 ID。
 * @param {number|string} userId - 用户 ID。
 * @returns {{clusterData:any[], clustersForThumbnails:any[], noiseSingletonCount:number}} 映射结果。
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

async function _requestPythonClusters(requestBody) {
  return clusterFaceEmbeddings(PYTHON_SERVICE_URL, requestBody)
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

    logger.info({
      message: `调用 Python 聚类服务: ${PYTHON_SERVICE_URL}/cluster_face_embeddings`,
      details: {
        embeddingCount: embeddings.length,
        threshold: threshold !== undefined && threshold !== null ? threshold : '使用配置文件默认值'
      }
    })

    let responseData
    try {
      responseData = await _requestPythonClusters(requestBody)
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(
          `无法连接到 Python 服务 (${PYTHON_SERVICE_URL})。请确保服务正在运行。\n提示: 在与本服务并列的 xiaoxiao-album-ai 目录执行 python3 start.py`
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
    }

    const nextClusterIdStart = getMaxClusterIdForUser(userId) + 1
    let { clusterData, clustersForThumbnails, noiseSingletonCount } = buildClusterAssignmentsFromPython(
      clusters,
      faceEmbeddings,
      nextClusterIdStart,
      userId
    )

    const merged = mergeAutoClustersAfterDbscan(clusterData, clustersForThumbnails, faceEmbeddings, {
      maxMinPairCosineDistance: MERGE_MAX_MIN_PAIR_COSINE_DIST,
      userId
    })
    clusterData = merged.clusterData
    clustersForThumbnails = merged.clustersForThumbnails

    logger.info({
      message: `解析完成，准备插入 ${clusterData.length} 条聚类数据`,
      details: {
        userId,
        nextClusterIdStart,
        pythonClusterGroupCount: clusters.length,
        noiseSingletonClusters: noiseSingletonCount,
        postDbscanMerge: {
          beforeClusterCount: merged.beforeClusterCount,
          afterClusterCount: merged.afterClusterCount,
          mergeGroupCount: merged.mergeGroupCount,
          maxMinPairCosineDistance: MERGE_MAX_MIN_PAIR_COSINE_DIST
        }
      }
    })

    const insertResult = insertFaceClusters(userId, clusterData, { replaceAutoExisting: recluster })
    if (recluster) {
      logger.info({
        message: '已在同一事务内完成自动聚类替换（先删后插）',
        details: { userId }
      })
    }
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
    await handleReclusterThumbnailMaintenance({
      userId,
      generatedThumbnailPaths,
      oldThumbnailPaths: recluster ? oldThumbnailPaths : [],
      oldCoverMapping: recluster ? oldCoverMapping : null
    })

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
