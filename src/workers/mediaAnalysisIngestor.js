/*
 * @Description: 媒体智能分析主链 Ingestor
 * - 图片：POST /analyze_image（multipart 或 image_path）
 * - 视频：POST /analyze_video（JSON + video_path，与设计方案 Phase 1 一致）
 */

const logger = require('../utils/logger')
const storageService = require('../services/storageService')
const { insertFaceEmbeddings, rebuildMediaSearchDoc, normalizeTextArray, updateAnalysisStatusPrimary } = require('../models/mediaModel')
const { getCloudConfigForAnalysis } = require('../services/cloudModelService')
const { updateProgressOnce } = require('../services/mediaProcessingProgressService')
const axios = require('axios')
const { UnrecoverableError } = require('bullmq')
const { withAiSlot } = require('../services/aiConcurrencyLimiter')
const { bullMqWillRetryAfterThisFailure } = require('../utils/queuePipelineLifecycle')
const { finalizeMediaAnalysis: finalizeMediaAnalysisInModel } = require('../models/mediaAnalysisModel')
const { upsertMediaEmbedding } = require('../models/mediaEmbeddingModel')
const { scheduleUserRebuild } = require('../services/cleanupGroupingScheduler')
const { scheduleUserClustering } = require('../services/faceClusterScheduler')
const PYTHON_SERVICE_URL = process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || 'http://localhost:5001'
// 图片分析超时：仅认 ANALYZE_IMAGE_TIMEOUT_MS，默认 120 秒
const ANALYZE_IMAGE_TIMEOUT_MS = Number(process.env.ANALYZE_IMAGE_TIMEOUT_MS || 120000)
/** 视频多帧分析，默认 10 分钟；可通过 ANALYZE_VIDEO_TIMEOUT_MS 覆盖 */
const ANALYZE_VIDEO_TIMEOUT_MS = Number(process.env.ANALYZE_VIDEO_TIMEOUT_MS || 600000)
// 与 .env 的 ANALYZE_IMAGE_USE_LOCAL_PATH 对应：未设置或 true → 本地存储时优先传 image_path；为 false 时强制 multipart
const ANALYZE_IMAGE_USE_LOCAL_PATH = process.env.ANALYZE_IMAGE_USE_LOCAL_PATH !== 'false'

// 最新设计：Node 侧不再决定「开启哪些能力」，一律视为参与分析；是否真正可用由 Python 端模型加载结果与降级逻辑决定
// 图中可读文字由 Python body.data.caption.data.ocr 写入 media.ai_ocr

async function processMediaAnalysis(job) {
  const { imageId, userId, highResStorageKey, originalStorageKey, sessionId, mediaType = 'image', fileName } = job.data || {}

  if (!imageId) {
    logger.warn({
      message: 'processMediaAnalysis 收到无效任务，缺少 imageId',
      details: { jobId: job.id, data: job.data }
    })
    return
  }

  try {
    if (mediaType === 'video') {
      const videoPath = await _resolveVideoLocalPath({ highResStorageKey, originalStorageKey, imageId, userId, fileName })
      if (!videoPath) {
        const err = new UnrecoverableError('VIDEO_FILE_NOT_FOUND_OR_NO_LOCAL_PATH')
        await _markMediaAnalysisFailed(imageId, err, sessionId, job)
        throw err
      }

      const stepResults = {
        face: { status: 'pending', errorCode: null, data: {} },
        cleanup: { status: 'pending', errorCode: null, data: {} },
        description: { status: 'pending', errorCode: null, data: {} }
      }

      await _runAnalyzeVideo({ imageId, userId, videoPath, stepResults })

      await finalizeMediaAnalysis({ imageId, stepResults })
      if (sessionId) {
        await updateProgressOnce({ sessionId, status: 'aiDoneCount', dedupeKey: imageId })
        logger.info({
          message: 'mediaAnalysis.progress.updated',
          details: { imageId, userId, sessionId: sessionId.substring(0, 8) + '...', status: 'aiDoneCount' }
        })
      } else {
        logger.warn({
          message: 'mediaAnalysis.progress.skipped_no_session',
          details: { imageId, userId, reason: 'sessionId 为空，智能分析进度不会更新' }
        })
      }

      logger.info({
        message: 'mediaAnalysis.video.completed',
        details: { imageId, userId }
      })
      return
    }

    const { imageData, localPath } = await _loadMediaBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName })
    if (!imageData && !localPath) {
      const err = new UnrecoverableError('MEDIA_FILE_NOT_FOUND')
      await _markMediaAnalysisFailed(imageId, err, sessionId, job)
      throw err
    }

    const stepResults = {
      face: { status: 'pending', errorCode: null, data: {} },
      cleanup: { status: 'pending', errorCode: null, data: {} },
      description: { status: 'pending', errorCode: null, data: {} }
    }

    await _runAnalyzeImage({ imageId, userId, imageData, localPath, stepResults })

    await finalizeMediaAnalysis({ imageId, stepResults })
    if (sessionId) {
      await updateProgressOnce({ sessionId, status: 'aiDoneCount', dedupeKey: imageId })
      logger.info({
        message: 'mediaAnalysis.progress.updated',
        details: { imageId, userId, sessionId: sessionId.substring(0, 8) + '...', status: 'aiDoneCount' }
      })
    } else {
      logger.warn({
        message: 'mediaAnalysis.progress.skipped_no_session',
        details: { imageId, userId, reason: 'sessionId 为空，智能分析进度不会更新' }
      })
    }

    logger.info({
      message: 'mediaAnalysis.image.completed',
      details: { imageId, userId, stepResults }
    })
  } catch (error) {
    logger.error({
      message: 'processMediaAnalysis failed',
      details: { imageId, userId, error: error.message }
    })
    try {
      await _markMediaAnalysisFailed(imageId, error, sessionId, job)
    } catch (e) {
      logger.warn({
        message: 'markMediaAnalysisFailed error (swallowed)',
        details: { imageId, error: e.message }
      })
    }
    throw error
  }
}

async function _loadMediaBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName }) {
  if (ANALYZE_IMAGE_USE_LOCAL_PATH) {
    if (highResStorageKey) {
      const p = await storageService.getLocalFilePath(highResStorageKey)
      if (p) {
        return { imageData: null, storageKey: highResStorageKey, localPath: p }
      }
    }
    if (originalStorageKey) {
      const p = await storageService.getLocalFilePath(originalStorageKey)
      if (p) {
        return { imageData: null, storageKey: originalStorageKey, localPath: p }
      }
    }
  }

  let imageData = null
  let storageKey = null

  if (highResStorageKey) {
    storageKey = highResStorageKey
    imageData = await storageService.storage.getFileBuffer(storageKey)
  }

  if (!imageData && originalStorageKey) {
    storageKey = originalStorageKey
    imageData = await storageService.storage.getFileBuffer(storageKey)
  }

  if (!imageData) {
    logger.warn({
      message: 'mediaAnalysis.loadImageBuffer.failed',
      details: { imageId, userId, highResStorageKey, originalStorageKey, fileName }
    })
  }

  return { imageData, storageKey, localPath: null }
}

/**
 * 视频原片本地路径（与 /analyze_video 设计方案一致：需 Python 与 Node 同卷可读）
 */
async function _resolveVideoLocalPath({ highResStorageKey, originalStorageKey, imageId, userId, fileName }) {
  if (ANALYZE_IMAGE_USE_LOCAL_PATH) {
    if (originalStorageKey) {
      const p = await storageService.getLocalFilePath(originalStorageKey)
      if (p) return p
    }
    if (highResStorageKey) {
      const p = await storageService.getLocalFilePath(highResStorageKey)
      if (p) return p
    }
  }
  logger.warn({
    message: 'mediaAnalysis.videoLocalPath.missing',
    details: { imageId, userId, highResStorageKey, originalStorageKey, fileName }
  })
  return null
}

async function _runAnalyzeVideo({ imageId, userId, videoPath, stepResults }) {
  const device = process.env.AI_DEVICE || 'auto'
  const cloudConfig = getCloudConfigForAnalysis(userId)
  const cloudEnabled = !!cloudConfig
  const response = await withAiSlot(() =>
    axios.post(
      `${PYTHON_SERVICE_URL}/analyze_video`,
      {
        video_path: videoPath,
        device,
        image_id: String(imageId),
        cloud_config: cloudConfig
      },
      {
        timeout: ANALYZE_VIDEO_TIMEOUT_MS,
        maxBodyLength: Infinity,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  )
  const body = response.data || {}
  _applyAdapterFromModules(imageId, userId, body, stepResults, { mediaType: 'video', cloudEnabled })
}

async function _markMediaAnalysisFailed(imageId, error, sessionId, job) {
  if (!imageId) {
    logger.error({
      message: 'markMediaAnalysisFailed called without imageId',
      details: { error: error?.message }
    })
    return
  }
  const finalFailure = !job || !bullMqWillRetryAfterThisFailure(job, error)
  if (finalFailure) {
    try {
      updateAnalysisStatusPrimary(imageId, 'failed')
    } catch {
      // ignore
    }
  }
  if (sessionId && finalFailure) {
    try {
      await updateProgressOnce({ sessionId, status: 'aiErrorCount', dedupeKey: imageId })
    } catch {
      // ignore
    }
  }
}

async function _runAnalyzeImage({ imageId, userId, imageData, localPath, stepResults }) {
  const { FormData, Blob } = globalThis
  if (!localPath && !imageData) {
    stepResults.cleanup = { status: 'failed', errorCode: 'ANALYZE_IMAGE_BUFFER_MISSING', data: {} }
    throw new Error('ANALYZE_IMAGE_BUFFER_MISSING')
  }
  const formData = new FormData()
  if (localPath) {
    formData.append('image_path', localPath)
  } else {
    const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: 'application/octet-stream' })
    formData.append('image', blob, `image-${imageId}.bin`)
  }
  const device = process.env.AI_DEVICE || 'auto'
  formData.append('device', device)
  formData.append('image_id', String(imageId))
  const cloudConfig = getCloudConfigForAnalysis(userId)
  const cloudEnabled = !!cloudConfig
  if (cloudConfig) {
    // cloud_config 作为 JSON 字符串透传给 Python
    formData.append('cloud_config', JSON.stringify(cloudConfig))
  }
  const response = await withAiSlot(() =>
    axios.post(`${PYTHON_SERVICE_URL}/analyze_image`, formData, {
      timeout: ANALYZE_IMAGE_TIMEOUT_MS,
      maxBodyLength: Infinity,
      headers: typeof formData.getHeaders === 'function' ? formData.getHeaders() : undefined
    })
  )
  const body = response.data || {}
  _applyAdapterFromModules(imageId, userId, body, stepResults, { mediaType: 'image', cloudEnabled })
}

function _applyAdapterFromModules(imageId, userId, body, stepResults, options = {}) {
  const mediaType = options.mediaType === 'video' ? 'video' : 'image'
  const cloudEnabled = options.cloudEnabled !== false
  const modules = body.data || {}
  const round2 = (v) => (typeof v === 'number' ? Number(v.toFixed(2)) : null)

  const captionModule = modules.caption
  const capStatus = captionModule?.status
  const capData = captionModule?.data

  let captionForDb = null
  if (capStatus === 'success') {
    if (capData) {
      captionForDb = _pickCaptionFieldsForDb(capData)
      if (captionForDb) {
        const d = capData
        const descriptionText = typeof d.description === 'string' ? d.description : ''
        const keywords = Array.isArray(d.keywords) ? d.keywords : []
        const subjectTags = Array.isArray(d.subject_tags) ? d.subject_tags : []
        const actionTags = Array.isArray(d.action_tags) ? d.action_tags : []
        const sceneTags = Array.isArray(d.scene_tags) ? d.scene_tags : []
        stepResults.description = {
          status: 'completed',
          errorCode: null,
          data: {
            description: descriptionText,
            keywords,
            subjectTags,
            actionTags,
            sceneTags
          }
        }
      } else {
        stepResults.description = { status: 'empty', errorCode: null, data: {} }
      }
    } else {
      stepResults.description = { status: 'empty', errorCode: null, data: {} }
    }
  } else {
    stepResults.description = { status: capStatus || 'failed', errorCode: captionModule?.error?.code || null, data: {} }
  }

  // 云阶段状态与 caption 文本：与 primary / 人脸 / 质量 同在 finalizeMediaAnalysis 一次 UPDATE
  if (!cloudEnabled) {
    stepResults.analysisCloudStatus = 'skipped'
  } else if (capStatus === 'success') {
    stepResults.analysisCloudStatus = 'success'
  } else if (capStatus === 'failed') {
    stepResults.analysisCloudStatus = 'failed'
  } else {
    stepResults.analysisCloudStatus = 'failed'
  }
  stepResults.captionForFinalize = captionForDb

  if (mediaType === 'video') {
    // 视频链路当前不返回 quality，cleanup 置为空完成态。
    stepResults.cleanup = { status: 'completed', errorCode: null, data: {} }
  } else if (modules.quality?.status === 'success') {
    if (modules.quality.data) {
      const d = modules.quality.data
      stepResults.cleanup = {
        status: 'completed',
        errorCode: null,
        data: {
          phash: d.hashes?.phash ?? null,
          dhash: d.hashes?.dhash ?? null,
          aestheticScore: round2(d.aesthetic_score),
          sharpnessScore: round2(d.sharpness_score)
        }
      }
    } else {
      stepResults.cleanup = { status: 'completed', errorCode: null, data: {} }
    }
  } else {
    stepResults.cleanup = { status: modules.quality?.status || 'failed', errorCode: modules.quality?.error?.code || null, data: {} }
  }

  if (mediaType === 'image' && modules.embedding?.status === 'success' && modules.embedding.data?.vector) {
    try {
      upsertMediaEmbedding({ imageId, vector: modules.embedding.data.vector })
    } catch (e) {
      logger.warn({ message: 'analyze_image adapter: upsertMediaEmbedding failed', details: { imageId, error: e.message } })
    }
  }
  if (mediaType === 'image' && (modules.quality?.status === 'success' || modules.embedding?.status === 'success') && userId) {
    scheduleUserRebuild(userId)
  }

  if (modules.person?.status === 'success') {
    if (!modules.person.data) {
      stepResults.face = { status: 'completed', errorCode: null, data: {} }
    } else {
      const d = modules.person.data
      const faceCount = d.face_count ?? 0
      const personCount = d.person_count ?? 0
      const faces = Array.isArray(d.faces) ? d.faces : []
      const summary = d.summary || {}
      const expressions = Array.isArray(summary.expressions) ? summary.expressions : []
      const expressionTagsText = expressions.length > 0 ? expressions.join(',') : null
      const ages = summary.ages || []
      const genders = summary.genders || []
      const preferredFaces = faces.filter((f) => {
        const e = typeof f?.expression === 'string' ? f.expression.trim().toLowerCase() : ''
        return e === 'happy' || e === 'neutral'
      })
      const maxFaceQuality = (arr) =>
        arr.reduce((acc, f) => {
          const q = Number(f?.quality_score)
          return Number.isFinite(q) ? Math.max(acc, q) : acc
        }, Number.NEGATIVE_INFINITY)
      const preferredQuality = maxFaceQuality(preferredFaces)
      const fallbackQuality = maxFaceQuality(faces)
      const preferredFaceQuality = Number.isFinite(preferredQuality) ? preferredQuality : Number.isFinite(fallbackQuality) ? fallbackQuality : null
      const ageTagsText = ages.length > 0 ? ages.join(',') : null
      const genderTagsText = genders.length > 0 ? genders.join(',') : null
      // 图片：is_high_quality；视频：person.data.faces 已是多帧去重列表，以有 embedding 为准
      const highQualityFaces =
        mediaType === 'video' ? faces.filter((f) => Array.isArray(f.embedding) && f.embedding.length > 0) : faces.filter((f) => f.is_high_quality)
      if (highQualityFaces.length > 0) {
        const toInsert = highQualityFaces.map((f) => ({
          face_index: f.face_index,
          embedding: f.embedding,
          age: f.age,
          gender: f.gender,
          expression: f.expression,
          confidence: f.expression_confidence ?? f.confidence,
          quality_score: f.quality_score,
          bbox: f.bbox || [],
          pose: f.pose || {}
        }))
        insertFaceEmbeddings(imageId, toInsert, { sourceType: mediaType })
      }
      stepResults.face = {
        status: 'completed',
        errorCode: null,
        data: {
          faceCount,
          personCount,
          preferredFaceQuality,
          expressionTagsText,
          ageTagsText,
          genderTagsText,
          hasClusterableFace: highQualityFaces.length > 0
        }
      }
      if (userId) scheduleUserClustering(userId)
    }
  } else {
    stepResults.face = { status: modules.person?.status || 'failed', errorCode: modules.person?.error?.code || null, data: {} }
  }

  // caption 成功时：media 表 face_count / person_count 以云侧为准（覆盖上面 person 写入的统计值）
  if (capStatus === 'success' && capData && typeof capData === 'object') {
    const fc = typeof capData.face_count === 'number' && Number.isFinite(capData.face_count) ? Math.max(0, Math.floor(capData.face_count)) : null
    const pc =
      typeof capData.person_count === 'number' && Number.isFinite(capData.person_count) ? Math.max(0, Math.floor(capData.person_count)) : null
    if (fc !== null || pc !== null) {
      if (!stepResults.face) stepResults.face = { status: 'completed', errorCode: null, data: {} }
      if (!stepResults.face.data) stepResults.face.data = {}
      if (fc !== null) stepResults.face.data.faceCount = fc
      if (pc !== null) stepResults.face.data.personCount = pc
    }
  }
}

/** Python caption.data 中非空字段才落库（finalize 中文本列与 upsertMediaAiFieldsForAnalysis 规则一致；人数由 faceData 合并后写入） */
function _pickCaptionFieldsForDb(capData) {
  if (!capData || typeof capData !== 'object') return null
  const out = {}
  const desc = typeof capData.description === 'string' ? capData.description.trim() : ''
  if (desc) out.description = desc
  const kw = normalizeTextArray(capData.keywords)
  if (kw.length > 0) out.keywords = kw
  const st = normalizeTextArray(capData.subject_tags)
  if (st.length > 0) out.subjectTags = st
  const at = normalizeTextArray(capData.action_tags)
  if (at.length > 0) out.actionTags = at
  const sc = normalizeTextArray(capData.scene_tags)
  if (sc.length > 0) out.sceneTags = sc
  const ocr = typeof capData.ocr === 'string' ? capData.ocr.trim() : ''
  if (ocr) out.ocr = ocr
  if (typeof capData.face_count === 'number' && Number.isFinite(capData.face_count)) {
    out.faceCount = Math.max(0, Math.floor(capData.face_count))
  }
  if (typeof capData.person_count === 'number' && Number.isFinite(capData.person_count)) {
    out.personCount = Math.max(0, Math.floor(capData.person_count))
  }
  return Object.keys(out).length > 0 ? out : null
}

async function finalizeMediaAnalysis({ imageId, stepResults }) {
  const faceData = stepResults.face?.data || {}
  const cleanupData = stepResults.cleanup?.data || {}
  const analysisStatusCloud = stepResults.analysisCloudStatus
  if (analysisStatusCloud == null) {
    throw new Error('finalizeMediaAnalysis: missing stepResults.analysisCloudStatus (adapter bug)')
  }

  finalizeMediaAnalysisInModel({
    mediaId: imageId,
    analysisStatusCloud,
    caption: stepResults.captionForFinalize ?? null,
    faceData,
    cleanupData
  })

  await rebuildMediaSearchDoc(imageId)
}

module.exports = {
  processMediaAnalysis
}
