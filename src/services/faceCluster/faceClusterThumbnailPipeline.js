/**
 * 人脸聚类缩略图与封面流水线：负责封面候选排序、缩略图生成、封面恢复与自愈。
 */
const logger = require('../../utils/logger')
const {
  getFaceEmbeddingsByIds,
  getMediasSharpnessByIds,
  updateFaceEmbeddingThumbnail,
  updateFaceClusterRepresentative,
  clearOtherDefaultCoverRepresentative,
  restoreClusterDefaultCover,
  getFaceEmbeddingRepresentativeValue,
  getRepresentativeStatusByThumbnailKeys,
  getDefaultCoverFaceEmbeddingId,
  getRepresentativeFaceEmbeddingIdsByUserId,
  getFaceEmbeddingIdsByClusterId
} = require('../../models/faceClusterModel')
const { getMediaStorageInfo } = require('../../models/mediaModel')
const storageService = require('../../services/storageService')
const { cropFaceThumbnail } = require('./faceClusterPythonClient')

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL

/**
 * 聚类后检查当前封面（representative_type=1/2）缩略图是否缺失，缺失则同步重建。
 * @param {number} userId 用户 ID
 * @returns {Promise<{checked:number, regenerated:number, failed:number}>}
 */
async function ensureRepresentativeCoverThumbnails(userId) {
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
 * 为每个 cluster 选择最佳人脸并生成缩略图。
 * @param {number} userId 用户 ID
 * @param {Array<{cluster_id:number, face_indices:number[]}>} clusters 聚类结果
 * @param {Array<{id:number}>} faceEmbeddings 人脸 embedding 列表
 * @returns {Promise<string[]>} 生成的缩略图路径列表
 */
async function generateThumbnailsForClusters(userId, clusters, faceEmbeddings) {
  let successCount = 0
  let failCount = 0
  const MAX_ERRORS = 5
  const generatedThumbnailPaths = []

  for (const cluster of clusters) {
    const clusterId = cluster.cluster_id
    const faceIndices = cluster.face_indices || []

    if (clusterId === -1 || faceIndices.length === 0) {
      continue
    }

    try {
      const clusterFaceIds = faceIndices.map((index) => faceEmbeddings[index]?.id).filter((id) => id != null)
      if (clusterFaceIds.length === 0) continue

      const clusterFaces = getFaceEmbeddingsByIds(clusterFaceIds)
      if (clusterFaces.length === 0) continue

      const mediaIds = [...new Set(clusterFaces.map((f) => f.image_id))]
      const imagesMap = getMediasSharpnessByIds(mediaIds)
      const mediaTypeByMediaId = new Map()
      for (const iid of mediaIds) {
        const info = getMediaStorageInfo(iid)
        mediaTypeByMediaId.set(iid, info?.mediaType || 'image')
      }

      const ranked = rankFacesForCover(clusterFaces, imagesMap, mediaTypeByMediaId)
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
        if (mediaTypeByMediaId.get(face.image_id) === 'video') continue
        const normalizedBbox = normalizeBboxFromFace(face)
        if (normalizedBbox) {
          bestFace = face
          bbox = normalizedBbox
          break
        }
      }

      if (!bestFace) {
        const repFace = ranked.find((f) => mediaTypeByMediaId.get(f.image_id) !== 'video') || ranked[0]
        clearOtherDefaultCoverRepresentative(userId, clusterId, repFace.id)
        updateFaceClusterRepresentative(userId, clusterId, repFace.id)
        logger.info({
          message: '簇内无人脸小图可用（视频或 bbox 无效），已标记默认封面，列表使用整图缩略图',
          details: { userId, clusterId, faceEmbeddingId: repFace.id }
        })
        continue
      }

      const imageInfo = getMediaStorageInfo(bestFace.image_id)
      if (!imageInfo) {
        logger.warn({
          message: `图片不存在: mediaId=${bestFace.image_id}`,
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
          message: `无法获取图片数据: mediaId=${bestFace.image_id}`,
          details: { userId, clusterId }
        })
        continue
      }

      if (!Buffer.isBuffer(imageData)) {
        logger.error({
          message: `图片数据格式错误: clusterId=${clusterId}`,
          details: { userId, clusterId, mediaId: bestFace.image_id }
        })
        continue
      }

      let responseData
      try {
        responseData = await cropFaceThumbnail(PYTHON_SERVICE_URL, imageData, bbox)
      } catch (error) {
        failCount++
        logger.error({
          message: `调用Python服务生成缩略图失败: clusterId=${clusterId} (错误${failCount}/${MAX_ERRORS})`,
          details: {
            error: error.message,
            status: error.response?.status,
            userId,
            clusterId,
            mediaId: bestFace.image_id
          }
        })

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
          throw new Error(errorMsg)
        }
        continue
      }

      const thumbnailBase64 = responseData.face_thumbnail_base64
      if (!thumbnailBase64) {
        logger.warn({
          message: `Python服务未返回缩略图: clusterId=${clusterId}`,
          details: { userId, clusterId }
        })
        continue
      }

      const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '')
      const imageBuffer = Buffer.from(base64Data, 'base64')
      const thumbnailStorageKey = `storage-local/face-thumbnails/${bestFace.image_id}-${bestFace.face_index}.jpg`

      await storageService.storage.storeFile(imageBuffer, thumbnailStorageKey, {
        contentType: 'image/jpeg'
      })

      generatedThumbnailPaths.push(thumbnailStorageKey)
      updateFaceEmbeddingThumbnail(bestFace.id, thumbnailStorageKey)
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
    }
  }

  return generatedThumbnailPaths
}

/**
 * 标准化 face.bbox 字段，返回合法四元组。
 * @param {{bbox:number[]|string}} face 人脸记录
 * @returns {number[]|null} 合法 bbox 或 null
 */
function normalizeBboxFromFace(face) {
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
 * 按封面策略排序人脸（前者更优），可选优先图片媒体。
 * @param {Array<any>} faces 人脸列表
 * @param {Map<number, any>} [imagesMap=new Map()] media id -> 图片信息
 * @param {Map<number, string>|null} [mediaTypeByMediaId=null] media id -> mediaType
 * @returns {Array<any>} 已排序人脸列表
 */
function rankFacesForCover(faces, imagesMap = new Map(), mediaTypeByMediaId = null) {
  if (!faces || faces.length === 0) {
    return []
  }

  const facesWithMetrics = faces.map((face) => {
    let bbox = face.bbox
    let pose = face.pose

    if (typeof bbox === 'string' && bbox.trim()) {
      try {
        bbox = JSON.parse(bbox)
      } catch {
        bbox = null
      }
    }
    if (typeof pose === 'string' && pose.trim()) {
      try {
        pose = JSON.parse(pose)
      } catch {
        pose = null
      }
    }

    const bboxArea = bbox && bbox.length === 4 ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : 0
    const yaw = pose?.yaw || 0
    const pitch = pose?.pitch || 0
    let poseScore = 1.0 - (Math.abs(yaw) / 90.0 + Math.abs(pitch) / 90.0) / 2.0
    poseScore = Math.max(0.0, poseScore)

    const expressionPriority = {
      happy: 2,
      neutral: 1
    }
    const expressionScore = expressionPriority[face.expression] || 0

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
    if (mediaTypeByMediaId) {
      const aV = mediaTypeByMediaId.get(a.image_id) === 'video' ? 1 : 0
      const bV = mediaTypeByMediaId.get(b.image_id) === 'video' ? 1 : 0
      if (aV !== bV) return aV - bV
    }

    if (a.expressionScore !== b.expressionScore) {
      return b.expressionScore - a.expressionScore
    }

    if (Math.abs(a.qualityScore - b.qualityScore) > 0.05) {
      return b.qualityScore - a.qualityScore
    }

    if (Math.abs(a.poseScore - b.poseScore) > 0.05) {
      return b.poseScore - a.poseScore
    }

    if (Math.abs(a.bboxArea - b.bboxArea) > 1000) {
      return b.bboxArea - a.bboxArea
    }

    if (Math.abs(a.sharpnessScore - b.sharpnessScore) > 0.05) {
      return b.sharpnessScore - a.sharpnessScore
    }

    return (b.image_created_at || 0) - (a.image_created_at || 0)
  })

  return facesWithMetrics
}

/**
 * 确保 cluster 至少有一个默认封面代表（representative_type=1）。
 * @param {number} userId 用户 ID
 * @param {number} clusterId 聚类 ID
 * @returns {Promise<number|null>} 选中的 face_embedding_id
 */
async function ensureDefaultCoverRepresentative(userId, clusterId) {
  const ids = getFaceEmbeddingIdsByClusterId(userId, clusterId)
  if (!ids || ids.length === 0) return null

  const faces = getFaceEmbeddingsByIds(ids)
  if (faces.length === 0) return null

  const mediaIds = [...new Set(faces.map((f) => f.image_id))]
  const imagesMap = getMediasSharpnessByIds(mediaIds)
  const mediaTypeByMediaId = new Map()
  for (const iid of mediaIds) {
    const info = getMediaStorageInfo(iid)
    mediaTypeByMediaId.set(iid, info?.mediaType || 'image')
  }

  const ranked = rankFacesForCover(faces, imagesMap, mediaTypeByMediaId)
  if (ranked.length === 0) return null

  let pickId = null
  for (const f of ranked) {
    const value = getFaceEmbeddingRepresentativeValue(userId, clusterId, f.id)
    if (value !== 2) {
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
 * 恢复聚类默认封面：清除手动封面（2）并恢复默认封面（1）。
 * @param {number} userId 用户 ID
 * @param {number} clusterId 聚类 ID
 * @returns {Promise<{faceEmbeddingId:number, thumbnailStorageKey:string|null}|null>}
 */
async function restoreDefaultCover(userId, clusterId) {
  try {
    let defaultFaceEmbeddingId = getDefaultCoverFaceEmbeddingId(userId, clusterId)
    if (!defaultFaceEmbeddingId) {
      defaultFaceEmbeddingId = await ensureDefaultCoverRepresentative(userId, clusterId)
    }

    if (!defaultFaceEmbeddingId) {
      logger.warn({
        message: `无法找到或补写默认封面: clusterId=${clusterId}`,
        details: { userId, clusterId }
      })
      return null
    }

    const faceEmbeddings = getFaceEmbeddingsByIds([defaultFaceEmbeddingId])
    if (faceEmbeddings.length === 0) {
      logger.warn({
        message: `默认封面对应的 face_embedding 不存在: faceEmbeddingId=${defaultFaceEmbeddingId}`,
        details: { userId, clusterId }
      })
      return null
    }

    const defaultFace = faceEmbeddings[0]
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
 * 为单个 face_embedding 生成缩略图（可选强制重建）。
 * @param {number} faceEmbeddingId face_embedding ID
 * @param {boolean} [forceRegenerate=false] 是否强制重建
 * @returns {Promise<string|null>} 缩略图存储键
 */
async function generateThumbnailForFaceEmbedding(faceEmbeddingId, forceRegenerate = false) {
  try {
    const faceEmbeddings = getFaceEmbeddingsByIds([faceEmbeddingId])
    if (faceEmbeddings.length === 0) {
      logger.warn({
        message: `face_embedding 不存在: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    const faceEmbedding = faceEmbeddings[0]
    if (faceEmbedding.face_thumbnail_storage_key && !forceRegenerate) {
      try {
        const fileExists = await storageService.storage.fileExists(faceEmbedding.face_thumbnail_storage_key)
        if (fileExists) {
          return faceEmbedding.face_thumbnail_storage_key
        }
        logger.warn({
          message: `缩略图文件不存在，将重新生成: faceEmbeddingId=${faceEmbeddingId}, storageKey=${faceEmbedding.face_thumbnail_storage_key}`
        })
      } catch (error) {
        logger.warn({
          message: `验证缩略图文件失败，将重新生成: faceEmbeddingId=${faceEmbeddingId}`,
          details: { error: error.message }
        })
      }
    }

    const imageInfo = getMediaStorageInfo(faceEmbedding.image_id)
    if (!imageInfo) {
      logger.warn({
        message: `图片不存在: mediaId=${faceEmbedding.image_id}`,
        details: { faceEmbeddingId }
      })
      return null
    }

    if (imageInfo.mediaType && imageInfo.mediaType !== 'image') {
      logger.warn({
        message: '跳过非图片媒体的聚类封面缩略图生成',
        details: { faceEmbeddingId, mediaId: faceEmbedding.image_id, mediaType: imageInfo.mediaType }
      })
      return null
    }

    let imageData = null
    const storageKey = imageInfo.highResStorageKey || imageInfo.originalStorageKey
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
        message: `无法获取图片数据: mediaId=${faceEmbedding.image_id}`,
        details: { faceEmbeddingId }
      })
      return null
    }

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

    if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
      logger.warn({
        message: `bbox格式无效: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    if (!Buffer.isBuffer(imageData)) {
      logger.error({
        message: `图片数据格式错误: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    let responseData
    try {
      responseData = await cropFaceThumbnail(PYTHON_SERVICE_URL, imageData, bbox)
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

    const thumbnailBase64 = responseData.face_thumbnail_base64
    if (!thumbnailBase64) {
      logger.warn({
        message: `Python服务未返回缩略图: faceEmbeddingId=${faceEmbeddingId}`
      })
      return null
    }

    const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '')
    const imageBuffer = Buffer.from(base64Data, 'base64')
    const thumbnailStorageKey = `storage-local/face-thumbnails/${faceEmbedding.image_id}-${faceEmbedding.face_index}.jpg`

    await storageService.storage.storeFile(imageBuffer, thumbnailStorageKey, {
      contentType: 'image/jpeg'
    })
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
  ensureRepresentativeCoverThumbnails,
  generateThumbnailsForClusters,
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
  getRepresentativeStatusByThumbnailKeys,
  getFaceEmbeddingsByIds
}
