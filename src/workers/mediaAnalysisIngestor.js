/*
 * @Description: 媒体智能分析主链 Ingestor（Phase 0 + Phase 1）
 * - Phase 0：建立骨架，支持 video 占位完成
 * - Phase 1：迁移 face + cleanup，统一 finalize
 */

const logger = require("../utils/logger");
const storageService = require("../services/storageService");
const {
  updateMediaSearchMetadata,
  insertFaceEmbeddings,
  rebuildMediaSearchDoc,
  upsertMediaAiFieldsForAnalysis,
  normalizeTextArray,
} = require("../models/mediaModel");
const { updateProgressOnce } = require("../services/mediaProcessingProgressService");
const axios = require("axios");
const { withAiSlot } = require("../services/aiConcurrencyLimiter");
const { markMediaAnalysisRunning, markMediaAnalysisFailed, finalizeMediaAnalysis: finalizeMediaAnalysisInModel } = require("../models/mediaAnalysisModel");
const { upsertMediaEmbedding } = require("../models/mediaEmbeddingModel");
const { scheduleUserRebuild } = require("../services/cleanupGroupingScheduler");
const { scheduleUserClustering } = require("../services/faceClusterScheduler");
const PYTHON_SERVICE_URL = process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";
// 优先 ANALYZE_IMAGE_TIMEOUT_MS；仍认 ANALYZE_FULL_TIMEOUT_MS 以兼容旧部署
const ANALYZE_IMAGE_TIMEOUT_MS = Number(
  process.env.ANALYZE_IMAGE_TIMEOUT_MS || process.env.ANALYZE_FULL_TIMEOUT_MS || 120000
);

// 最新设计：Node 侧不再决定「开启哪些能力」，一律视为参与分析；是否真正可用由 Python 端模型加载结果与降级逻辑决定
// 图中可读文字由 Python body.data.caption.data.ocr 写入 media.ai_ocr

async function processMediaAnalysis(job) {
  const { imageId, userId, highResStorageKey, originalStorageKey, sessionId, mediaType = "image", fileName } = job.data || {};

  if (!imageId) {
    logger.warn({
      message: "processMediaAnalysis 收到无效任务，缺少 imageId",
      details: { jobId: job.id, data: job.data },
    });
    return;
  }

  try {
    if (mediaType === "video") {
      await _markVideoAnalysisDone(imageId, sessionId);
      logger.info({
        message: "mediaAnalysis.video.completed",
        details: { imageId, userId, sessionId },
      });
      return;
    }

    const { imageData, storageKey } = await _loadMediaBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName });
    if (!imageData) {
      const err = new Error("MEDIA_FILE_NOT_FOUND");
      await _markMediaAnalysisFailed(imageId, err);
      throw err;
    }

    await _markMediaAnalysisRunning(imageId);

    const stepResults = {
      face: { status: "pending", errorCode: null, data: {} },
      cleanup: { status: "pending", errorCode: null, data: {} },
      description: { status: "pending", errorCode: null, data: {} },
    };

    await _runAnalyzeFull({ imageId, userId, imageData, stepResults });

    await finalizeMediaAnalysis({ imageId, stepResults });
    if (sessionId) {
      await updateProgressOnce({ sessionId, status: "aiDoneCount", dedupeKey: imageId });
      logger.info({
        message: "mediaAnalysis.progress.updated",
        details: { imageId, userId, sessionId: sessionId.substring(0, 8) + "...", status: "aiDoneCount" },
      });
    } else {
      logger.warn({
        message: "mediaAnalysis.progress.skipped_no_session",
        details: { imageId, userId, reason: "sessionId 为空，智能分析进度不会更新" },
      });
    }

    logger.info({
      message: "mediaAnalysis.image.completed",
      details: { imageId, userId, stepResults },
    });
  } catch (error) {
    logger.error({
      message: "processMediaAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    try {
      await _markMediaAnalysisFailed(imageId, error);
    } catch (e) {
      logger.warn({
        message: "markMediaAnalysisFailed error (swallowed)",
        details: { imageId, error: e.message },
      });
    }
    throw error;
  }
}

async function _loadMediaBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName }) {
  let imageData = null;
  let storageKey = null;

  if (highResStorageKey) {
    storageKey = highResStorageKey;
    imageData = await storageService.storage.getFileBuffer(storageKey);
  }

  if (!imageData && originalStorageKey) {
    storageKey = originalStorageKey;
    imageData = await storageService.storage.getFileBuffer(storageKey);
  }

  if (!imageData) {
    logger.warn({
      message: "mediaAnalysis.loadImageBuffer.failed",
      details: { imageId, userId, highResStorageKey, originalStorageKey, fileName },
    });
  }

  return { imageData, storageKey };
}

async function _markVideoAnalysisDone(imageId, sessionId) {
  await updateMediaSearchMetadata({ imageId });
  if (sessionId) {
    await updateProgressOnce({ sessionId, status: "aiDoneCount", dedupeKey: imageId });
  }
}

async function _markMediaAnalysisRunning(imageId) {
  markMediaAnalysisRunning(imageId);
}

async function _markMediaAnalysisFailed(imageId, error) {
  if (!imageId) {
    logger.error({
      message: "markMediaAnalysisFailed called without imageId",
      details: { error: error?.message },
    });
    return;
  }
  markMediaAnalysisFailed(imageId, error);
}

async function _runAnalyzeFull({ imageId, userId, imageData, stepResults }) {
  const { FormData, Blob } = globalThis;
  if (!imageData) {
    stepResults.cleanup = { status: "failed", errorCode: "ANALYZE_IMAGE_BUFFER_MISSING", data: {} };
    throw new Error("ANALYZE_IMAGE_BUFFER_MISSING");
  }
  const formData = new FormData();
  const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: "application/octet-stream" });
  formData.append("image", blob, `image-${imageId}.bin`);
  const device = process.env.AI_DEVICE || "auto";
  formData.append("device", device);
  formData.append("image_id", String(imageId));
  const response = await withAiSlot(() =>
    axios.post(`${PYTHON_SERVICE_URL}/analyze_image`, formData, {
      timeout: ANALYZE_IMAGE_TIMEOUT_MS,
      maxBodyLength: Infinity,
      headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
    }),
  );
  const body = response.data || {};
  _applyAdapterFromModules(imageId, userId, body, stepResults);
}

function _applyAdapterFromModules(imageId, userId, body, stepResults) {
  const modules = body.data || {};
  const round2 = (v) => (typeof v === "number" ? Number(v.toFixed(2)) : null);

  const captionModule = modules.caption;
  const capStatus = captionModule?.status;
  const capData = captionModule?.data;

  let captionForDb = null;
  if (capStatus === "success") {
    if (capData) {
      captionForDb = _pickCaptionFieldsForDb(capData);
      if (captionForDb) {
        const d = capData;
        const descriptionText = typeof d.description === "string" ? d.description : "";
        const keywords = Array.isArray(d.keywords) ? d.keywords : [];
        const subjectTags = Array.isArray(d.subject_tags) ? d.subject_tags : [];
        const actionTags = Array.isArray(d.action_tags) ? d.action_tags : [];
        const sceneTags = Array.isArray(d.scene_tags) ? d.scene_tags : [];
        stepResults.description = {
          status: "completed",
          errorCode: null,
          data: {
            description: descriptionText,
            keywords,
            subjectTags,
            actionTags,
            sceneTags,
          },
        };
      } else {
        stepResults.description = { status: "empty", errorCode: null, data: {} };
      }
    } else {
      stepResults.description = { status: "empty", errorCode: null, data: {} };
    }
  } else {
    stepResults.description = { status: capStatus || "failed", errorCode: captionModule?.error?.code || null, data: {} };
  }

  upsertMediaAiFieldsForAnalysis({
    mediaId: imageId,
    caption: captionForDb,
  });

  if (modules.quality?.status === "success") {
    if (modules.quality.data) {
      const d = modules.quality.data;
      stepResults.cleanup = {
        status: "completed",
        errorCode: null,
        data: {
          phash: d.hashes?.phash ?? null,
          dhash: d.hashes?.dhash ?? null,
          aestheticScore: round2(d.aesthetic_score),
          sharpnessScore: round2(d.sharpness_score),
        },
      };
    } else {
      stepResults.cleanup = { status: "completed", errorCode: null, data: {} };
    }
  } else {
    stepResults.cleanup = { status: modules.quality?.status || "failed", errorCode: modules.quality?.error?.code || null, data: {} };
  }

  if (modules.embedding?.status === "success" && modules.embedding.data?.vector) {
    try {
      upsertMediaEmbedding({ imageId, vector: modules.embedding.data.vector });
    } catch (e) {
      logger.warn({ message: "analyze_image adapter: upsertMediaEmbedding failed", details: { imageId, error: e.message } });
    }
  }
  if ((modules.quality?.status === "success" || modules.embedding?.status === "success") && userId) {
    scheduleUserRebuild(userId);
  }

  if (modules.person?.status === "success") {
    if (!modules.person.data) {
      stepResults.face = { status: "completed", errorCode: null, data: {} };
    } else {
      const d = modules.person.data;
      const faceCount = d.face_count ?? 0;
      const personCount = d.person_count ?? 0;
      const faces = Array.isArray(d.faces) ? d.faces : [];
      const summary = d.summary || {};
      const expressions = summary.expressions || [];
      const expressionTagsText = expressions.length > 0 ? expressions.join(",") : null;
      const ages = summary.ages || [];
      const genders = summary.genders || [];
      const primaryFace = faces[0];
      const ageTagsText = ages.length > 0 ? ages.join(",") : null;
      const genderTagsText = genders.length > 0 ? genders.join(",") : null;
      const highQualityFaces = faces.filter((f) => f.is_high_quality);
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
          pose: f.pose || {},
        }));
        insertFaceEmbeddings(imageId, toInsert);
      }
      stepResults.face = {
        status: "completed",
        errorCode: null,
        data: {
          faceCount,
          personCount,
          primaryFaceQuality: primaryFace?.quality_score ?? null,
          primaryExpression: expressions[0] ?? null,
          primaryExpressionConfidence: primaryFace?.expression_confidence ?? null,
          expressionTagsText,
          ageTagsText,
          genderTagsText,
          hasClusterableFace: highQualityFaces.length > 0,
        },
      };
      if (userId) scheduleUserClustering(userId);
    }
  } else {
    stepResults.face = { status: modules.person?.status || "failed", errorCode: modules.person?.error?.code || null, data: {} };
  }

  // caption 成功时：media 表 face_count / person_count 以云侧为准（覆盖上面 person 写入的统计值）
  if (capStatus === "success" && capData && typeof capData === "object") {
    const fc =
      typeof capData.face_count === "number" && Number.isFinite(capData.face_count)
        ? Math.max(0, Math.floor(capData.face_count))
        : null;
    const pc =
      typeof capData.person_count === "number" && Number.isFinite(capData.person_count)
        ? Math.max(0, Math.floor(capData.person_count))
        : null;
    if (fc !== null || pc !== null) {
      if (!stepResults.face) stepResults.face = { status: "completed", errorCode: null, data: {} };
      if (!stepResults.face.data) stepResults.face.data = {};
      if (fc !== null) stepResults.face.data.faceCount = fc;
      if (pc !== null) stepResults.face.data.personCount = pc;
    }
  }
}

/** Python caption.data 中非空字段才落库（与 upsertMediaAiFieldsForAnalysis 一致） */
function _pickCaptionFieldsForDb(capData) {
  if (!capData || typeof capData !== "object") return null;
  const out = {};
  const desc = typeof capData.description === "string" ? capData.description.trim() : "";
  if (desc) out.description = desc;
  const kw = normalizeTextArray(capData.keywords);
  if (kw.length > 0) out.keywords = kw;
  const st = normalizeTextArray(capData.subject_tags);
  if (st.length > 0) out.subjectTags = st;
  const at = normalizeTextArray(capData.action_tags);
  if (at.length > 0) out.actionTags = at;
  const sc = normalizeTextArray(capData.scene_tags);
  if (sc.length > 0) out.sceneTags = sc;
  const ocr = typeof capData.ocr === "string" ? capData.ocr.trim() : "";
  if (ocr) out.ocr = ocr;
  if (typeof capData.face_count === "number" && Number.isFinite(capData.face_count)) {
    out.faceCount = Math.max(0, Math.floor(capData.face_count));
  }
  if (typeof capData.person_count === "number" && Number.isFinite(capData.person_count)) {
    out.personCount = Math.max(0, Math.floor(capData.person_count));
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function finalizeMediaAnalysis({ imageId, stepResults }) {
  const faceData = stepResults.face?.data || {};
  const cleanupData = stepResults.cleanup?.data || {};
  const descriptionData = stepResults.description?.data || {};

  finalizeMediaAnalysisInModel({
    mediaId: imageId,
    faceData,
    cleanupData,
    descriptionData,
  });

  await rebuildMediaSearchDoc(imageId);
}

module.exports = {
  processMediaAnalysis,
};
