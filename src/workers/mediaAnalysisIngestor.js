/*
 * @Description: 媒体智能分析主链 Ingestor
 * - 图片：POST /analyze_image（multipart 或 image_path）
 * - 视频：POST /analyze_video（JSON + video_path，与设计方案 Phase 1 一致）
 */

const logger = require('../utils/logger')
const storageService = require('../services/storageService')
const {
  insertFaceEmbeddings,
  updateAnalysisStatusPrimary,
  finalizeMediaAnalysis: finalizeMediaAnalysisInModel
} = require('../services/mediaAnalysisPipelineService')
const { rebuildMediaSearchDoc } = require('../services/mediaService')
const { getCloudConfigForAnalysis } = require('../services/cloudModelService')
const { updateProgressOnce } = require('../services/mediaProcessingProgressService')
const axios = require('axios')
const { UnrecoverableError } = require('bullmq')
const { withAiSlot } = require('../services/aiConcurrencyLimiter')
const { bullMqWillRetryAfterThisFailure } = require('../utils/bullmq/queuePipelineLifecycle')
const { scheduleUserRebuild } = require('../services/cleanupGroupingScheduler')
const { scheduleUserClustering } = require('../services/faceCluster')
const { buildCaptionForDb, mapCaptionModuleStatus } = require('../utils/caption/captionNormalization')
const { ANALYZE_IMAGE_TIMEOUT_MS, ANALYZE_VIDEO_TIMEOUT_MS } = require('../utils/pythonServiceAnalyze')
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL
// 与 .env 的 ANALYZE_IMAGE_USE_LOCAL_PATH 对应：未设置或 true → 本地存储时优先传 image_path；为 false 时强制 multipart
const ANALYZE_IMAGE_USE_LOCAL_PATH = process.env.ANALYZE_IMAGE_USE_LOCAL_PATH !== 'false'

// 最新设计：Node 侧不再决定「开启哪些能力」，一律视为参与分析；是否真正可用由 Python 端模型加载结果与降级逻辑决定
// 图中可读文字由 Python body.data.caption.data.ocr 写入 media.ai_ocr

/**
 * 媒体智能分析主流程（图片/视频）。
 * @param {import('bullmq').Job} job - BullMQ 任务对象。
 * @returns {Promise<void>} 无返回值。
 */
async function processMediaAnalysis(job) {
  const { mediaId, userId, highResStorageKey, originalStorageKey, sessionId, mediaType = 'image', fileName } = job.data || {}

  if (!mediaId) {
    logger.warn({
      message: 'processMediaAnalysis 收到无效任务，缺少 mediaId',
      details: { jobId: job.id, data: job.data }
    })
    return
  }
  try {
    const [highResLocalPath, originalLocalPath] = await Promise.all([
      highResStorageKey ? storageService.getLocalFilePath(highResStorageKey) : Promise.resolve(null),
      originalStorageKey ? storageService.getLocalFilePath(originalStorageKey) : Promise.resolve(null)
    ])
  } catch (e) {
  }

  try {
    if (mediaType === 'video') {
      const videoPath = await _resolveVideoLocalPath({ highResStorageKey, originalStorageKey, mediaId, userId, fileName })
      if (!videoPath) {
        const err = new UnrecoverableError('VIDEO_FILE_NOT_FOUND_OR_NO_LOCAL_PATH')
        await _markMediaAnalysisFailed(mediaId, err, sessionId, job)
        throw err
      }

      const stepResults = {
        face: { status: 'pending', errorCode: null, data: {} },
        cleanup: { status: 'pending', errorCode: null, data: {} },
        description: { status: 'pending', errorCode: null, data: {} }
      }

      await _runAnalyzeVideo({ mediaId, userId, videoPath, stepResults })

      await finalizeMediaAnalysis({ mediaId, stepResults })
      if (sessionId) {
        await updateProgressOnce({ sessionId, status: 'aiDoneCount', dedupeKey: mediaId })
        logger.info({
          message: 'mediaAnalysis.progress.updated',
          details: { mediaId, userId, sessionId: sessionId.substring(0, 8) + '...', status: 'aiDoneCount' }
        })
      } else {
        logger.warn({
          message: 'mediaAnalysis.progress.skipped_no_session',
          details: { mediaId, userId, reason: 'sessionId 为空，智能分析进度不会更新' }
        })
      }

      logger.info({
        message: 'mediaAnalysis.video.completed',
        details: { mediaId, userId }
      })
      return
    }

    const { imageData, localPath } = await _loadMediaBuffer({ highResStorageKey, originalStorageKey, mediaId, userId, fileName })
    if (!imageData && !localPath) {
      const err = new UnrecoverableError('MEDIA_FILE_NOT_FOUND')
      await _markMediaAnalysisFailed(mediaId, err, sessionId, job)
      throw err
    }

    const stepResults = {
      face: { status: 'pending', errorCode: null, data: {} },
      cleanup: { status: 'pending', errorCode: null, data: {} },
      description: { status: 'pending', errorCode: null, data: {} }
    }

    await _runAnalyzeImage({ mediaId, userId, imageData, localPath, stepResults })

    await finalizeMediaAnalysis({ mediaId, stepResults })
    if (sessionId) {
      await updateProgressOnce({ sessionId, status: 'aiDoneCount', dedupeKey: mediaId })
      logger.info({
        message: 'mediaAnalysis.progress.updated',
        details: { mediaId, userId, sessionId: sessionId.substring(0, 8) + '...', status: 'aiDoneCount' }
      })
    } else {
      logger.warn({
        message: 'mediaAnalysis.progress.skipped_no_session',
        details: { mediaId, userId, reason: 'sessionId 为空，智能分析进度不会更新' }
      })
    }

    logger.info({
      message: 'mediaAnalysis.image.completed',
      details: { mediaId, userId, stepResults }
    })
  } catch (error) {
    logger.error({
      message: 'processMediaAnalysis failed',
      details: { mediaId, userId, error: error.message }
    })
    try {
      await _markMediaAnalysisFailed(mediaId, error, sessionId, job)
    } catch (e) {
      logger.warn({
        message: 'markMediaAnalysisFailed error (swallowed)',
        details: { mediaId, error: e.message }
      })
    }
    throw error
  }
}

/**
 * 读取图片输入（优先本地路径，否则读取 Buffer）。
 * @param {{highResStorageKey?:string|null,originalStorageKey?:string|null,mediaId:number,userId:number|string,fileName?:string}} params - 加载参数。
 * @returns {Promise<{imageData:Buffer|null,localPath:string|null}>} 图片数据或本地路径。
 */
async function _loadMediaBuffer({ highResStorageKey, originalStorageKey, mediaId, userId, fileName }) {
  try {
    const [highResLocalPath, originalLocalPath] = await Promise.all([
      highResStorageKey ? storageService.getLocalFilePath(highResStorageKey) : Promise.resolve(null),
      originalStorageKey ? storageService.getLocalFilePath(originalStorageKey) : Promise.resolve(null)
    ])
  } catch (e) {
  }

  if (ANALYZE_IMAGE_USE_LOCAL_PATH) {
    if (highResStorageKey) {
      const p = await storageService.getLocalFilePath(highResStorageKey)
      if (p) {
        return { imageData: null, localPath: p }
      }
    }
    if (originalStorageKey) {
      const p = await storageService.getLocalFilePath(originalStorageKey)
      if (p) {
        return { imageData: null, localPath: p }
      }
    }
  }

  let imageData = null

  if (highResStorageKey) {
    imageData = await storageService.storage.getFileBuffer(highResStorageKey)
    if (imageData) {
    }
  }

  if (!imageData && originalStorageKey) {
    imageData = await storageService.storage.getFileBuffer(originalStorageKey)
    if (imageData) {
    }
  }

  if (!imageData) {
    logger.warn({
      message: 'mediaAnalysis.loadImageBuffer.failed',
      details: { mediaId, userId, highResStorageKey, originalStorageKey, fileName }
    })
  }

  return { imageData, localPath: null }
}

/**
 * 视频原片本地路径（与 /analyze_video 设计方案一致：需 Python 与 Node 同卷可读）
 * @param {{highResStorageKey?:string|null,originalStorageKey?:string|null,mediaId:number,userId:number|string,fileName?:string}} params - 解析参数。
 * @returns {Promise<string|null>} 视频本地路径。
 */
async function _resolveVideoLocalPath({ highResStorageKey, originalStorageKey, mediaId, userId, fileName }) {
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
    details: { mediaId, userId, highResStorageKey, originalStorageKey, fileName }
  })
  return null
}

/**
 * 调用 Python `/analyze_video` 并将结果写入 stepResults。
 * @param {{mediaId:number,userId:number|string,videoPath:string,stepResults:Object}} params - 调用参数。
 * @returns {Promise<void>} 无返回值。
 */
async function _runAnalyzeVideo({ mediaId, userId, videoPath, stepResults }) {
  const device = process.env.AI_DEVICE || 'auto'
  const cloudConfig = getCloudConfigForAnalysis(userId)
  const cloudEnabled = !!cloudConfig
  let response
  try {
    response = await withAiSlot(() =>
      axios.post(
        `${PYTHON_SERVICE_URL}/analyze_video`,
        {
          video_path: videoPath,
          device,
          image_id: String(mediaId),
          cloud_config: cloudConfig
        },
        {
          timeout: ANALYZE_VIDEO_TIMEOUT_MS,
          maxBodyLength: Infinity,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )
  } catch (error) {
    throw error
  }
  const body = response.data || {}
  _applyAdapterFromModules(mediaId, userId, body, stepResults, { mediaType: 'video', cloudEnabled })
}

/**
 * 处理 AI 分析失败后的状态落库与进度标记。
 * @param {number} mediaId - 媒体 ID。
 * @param {unknown} error - 失败错误。
 * @param {string|undefined} sessionId - 会话 ID。
 * @param {import('bullmq').Job|undefined} job - BullMQ 任务对象。
 * @returns {Promise<void>} 无返回值。
 */
async function _markMediaAnalysisFailed(mediaId, error, sessionId, job) {
  if (!mediaId) {
    logger.error({
      message: 'markMediaAnalysisFailed called without mediaId',
      details: { error: error?.message }
    })
    return
  }
  const finalFailure = !job || !bullMqWillRetryAfterThisFailure(job, error)
  if (finalFailure) {
    try {
      updateAnalysisStatusPrimary(mediaId, 'failed')
    } catch {
      // ignore
    }
  }
  if (sessionId && finalFailure) {
    try {
      await updateProgressOnce({ sessionId, status: 'aiErrorCount', dedupeKey: mediaId })
    } catch {
      // ignore
    }
  }
}

/**
 * 调用 Python `/analyze_image` 并将结果写入 stepResults。
 * @param {{mediaId:number,userId:number|string,imageData:Buffer|null,localPath:string|null,stepResults:Object}} params - 调用参数。
 * @returns {Promise<void>} 无返回值。
 */
async function _runAnalyzeImage({ mediaId, userId, imageData, localPath, stepResults }) {
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
    formData.append('image', blob, `image-${mediaId}.bin`)
  }
  const device = process.env.AI_DEVICE || 'auto'
  formData.append('device', device)
  formData.append('image_id', String(mediaId))
  const cloudConfig = getCloudConfigForAnalysis(userId)
  const cloudEnabled = !!cloudConfig
  if (cloudConfig) {
    // cloud_config 作为 JSON 字符串透传给 Python
    formData.append('cloud_config', JSON.stringify(cloudConfig))
  }
  let response
  try {
    response = await withAiSlot(() =>
      axios.post(`${PYTHON_SERVICE_URL}/analyze_image`, formData, {
        timeout: ANALYZE_IMAGE_TIMEOUT_MS,
        maxBodyLength: Infinity,
        headers: typeof formData.getHeaders === 'function' ? formData.getHeaders() : undefined
      })
    )
  } catch (error) {
    throw error
  }
  const body = response.data || {}
  _applyAdapterFromModules(mediaId, userId, body, stepResults, { mediaType: 'image', cloudEnabled })
}

/**
 * 将 Python 模块化输出映射到业务 stepResults。
 * @param {number} mediaId - 媒体 ID。
 * @param {number|string} userId - 用户 ID。
 * @param {Object} body - Python 返回体。
 * @param {Object} stepResults - 步骤结果对象。
 * @param {{mediaType?:'image'|'video',cloudEnabled?:boolean}} [options] - 映射选项。
 * @returns {void} 无返回值。
 */
function _roundTo2OrNull(value) {
  if (typeof value !== 'number') return null
  return Number(value.toFixed(2))
}

/**
 * 计算人脸数组中的最大 quality_score。
 * @param {Array<{quality_score?:number}>} faces - 人脸数组。
 * @returns {number} 最大质量分，若无有效值返回 `Number.NEGATIVE_INFINITY`。
 */
function _maxFaceQuality(faces) {
  return faces.reduce((acc, face) => {
    const q = Number(face?.quality_score)
    return Number.isFinite(q) ? Math.max(acc, q) : acc
  }, Number.NEGATIVE_INFINITY)
}

/**
 * 将 Python 模块化输出映射到业务 stepResults。
 * @param {number} mediaId - 媒体 ID。
 * @param {number|string} userId - 用户 ID。
 * @param {Object} body - Python 返回体。
 * @param {Object} stepResults - 步骤结果对象。
 * @param {{mediaType?:'image'|'video',cloudEnabled?:boolean}} [options] - 映射选项。
 * @returns {void} 无返回值。
 */
function _applyAdapterFromModules(mediaId, userId, body, stepResults, options = {}) {
  const mediaType = options.mediaType === 'video' ? 'video' : 'image'
  const cloudEnabled = options.cloudEnabled !== false
  const modules = body.data || {}

  const captionModule = modules.caption
  const capStatus = captionModule?.status
  const capData = captionModule?.data

  let captionForDb = null
  if (capStatus === 'success') {
    if (capData) {
      captionForDb = buildCaptionForDb(capData)
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
  stepResults.analysisCloudStatus = mapCaptionModuleStatus(capStatus, { cloudEnabled })
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
          sharpnessScore: _roundTo2OrNull(d.sharpness_score)
        }
      }
    } else {
      stepResults.cleanup = { status: 'completed', errorCode: null, data: {} }
    }
  } else {
    stepResults.cleanup = { status: modules.quality?.status || 'failed', errorCode: modules.quality?.error?.code || null, data: {} }
  }

  if (mediaType === 'image' && modules.quality?.status === 'success' && userId) {
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
      const preferredQuality = _maxFaceQuality(preferredFaces)
      const fallbackQuality = _maxFaceQuality(faces)
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
        insertFaceEmbeddings(mediaId, toInsert, { sourceType: mediaType })
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

/**
 * 汇总 stepResults 并完成媒体分析落库。
 * @param {{mediaId:number,stepResults:Object}} params - 汇总参数。
 * @returns {Promise<void>} 无返回值。
 */
async function finalizeMediaAnalysis({ mediaId, stepResults }) {
  const faceData = stepResults.face?.data || {}
  const cleanupData = stepResults.cleanup?.data || {}
  const analysisStatusCloud = stepResults.analysisCloudStatus
  if (analysisStatusCloud == null) {
    throw new Error('finalizeMediaAnalysis: missing stepResults.analysisCloudStatus (adapter bug)')
  }

  finalizeMediaAnalysisInModel({
    mediaId: mediaId,
    analysisStatusCloud,
    caption: stepResults.captionForFinalize ?? null,
    faceData,
    cleanupData
  })

  await rebuildMediaSearchDoc(mediaId)
}

module.exports = {
  processMediaAnalysis
}
