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
  upsertMediaCaptionsForAnalysis,
  upsertMediaTextBlocksOcrForAnalysis,
} = require("../models/mediaModel");
const { updateProgressOnce } = require("../services/mediaProcessingProgressService");
const axios = require("axios");
const { withAiSlot } = require("../services/aiConcurrencyLimiter");
const { markMediaAnalysisRunning, markMediaAnalysisFailed, finalizeMediaAnalysis: finalizeMediaAnalysisInModel } = require("../models/mediaAnalysisModel");
const cleanupModel = require("../models/cleanupModel");
const { upsertMediaEmbedding } = require("../models/mediaEmbeddingModel");
const { scheduleUserRebuild } = require("../services/cleanupGroupingScheduler");
const { scheduleUserClustering } = require("../services/faceClusterScheduler");

const PYTHON_SERVICE_URL = process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";
const ANALYZE_FULL_TIMEOUT_MS = Number(process.env.ANALYZE_FULL_TIMEOUT_MS || 120000);

const ANALYSIS_VERSION = process.env.ANALYSIS_VERSION || "1.0";

// 最新设计：Node 侧不再决定「开启哪些能力」，一律视为参与分析；是否真正可用由 Python 端模型加载结果与降级逻辑决定
// 最新设计说明：
// - Node 侧不再提供按能力维度的开关，face / caption / OCR 均视为分析流程的一部分
// - 是否真正可用由 Python 端模型加载结果与降级逻辑决定，这里只关注「哪些步骤参与 done 判定」

async function processMediaAnalysis(job) {
  const { imageId, userId, highResStorageKey, originalStorageKey, sessionId, mediaType = "image", fileName } = job.data || {};

  if (!imageId) {
    logger.warn({
      message: "processMediaAnalysis 收到无效任务，缺少 imageId",
      details: { jobId: job.id, data: job.data },
    });
    return;
  }

  const analysisVersion = job.data.analysisVersion || ANALYSIS_VERSION;

  try {
    if (mediaType === "video") {
      await _markVideoAnalysisDone(imageId, sessionId, analysisVersion);
      logger.info({
        message: "mediaAnalysis.video.completed",
        details: { imageId, userId, sessionId, analysisVersion },
      });
      return;
    }

    const { imageData, storageKey } = await _loadMediaBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName });
    if (!imageData) {
      const err = new Error("MEDIA_FILE_NOT_FOUND");
      await _markMediaAnalysisFailed(imageId, analysisVersion, err);
      throw err;
    }

    await _markMediaAnalysisRunning(imageId, analysisVersion);

    const stepResults = {
      face: { status: "pending", errorCode: null, data: {} },
      cleanup: { status: "pending", errorCode: null, data: {} },
      caption: { status: "pending", errorCode: null, data: {} },
      ocr: { status: "pending", errorCode: null, data: {} },
    };

    await _runAnalyzeFull({ imageId, userId, imageData, analysisVersion, stepResults });

    await finalizeMediaAnalysis({ imageId, userId, analysisVersion, stepResults });

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
      details: { imageId, userId, analysisVersion, stepResults },
    });
  } catch (error) {
    logger.error({
      message: "processMediaAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    try {
      await _markMediaAnalysisFailed(imageId, analysisVersion, error);
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

async function _markVideoAnalysisDone(imageId, sessionId, analysisVersion) {
  await updateMediaSearchMetadata({ imageId, analysisVersion });
  if (sessionId) {
    await updateProgressOnce({ sessionId, status: "aiDoneCount", dedupeKey: imageId });
  }
}

async function _markMediaAnalysisRunning(imageId, analysisVersion) {
  markMediaAnalysisRunning(imageId, analysisVersion);
}

async function _markMediaAnalysisFailed(imageId, analysisVersion, error) {
  if (!imageId) {
    logger.error({
      message: "markMediaAnalysisFailed called without imageId",
      details: { analysisVersion, error: error?.message },
    });
    return;
  }
  markMediaAnalysisFailed(imageId, analysisVersion, error);
}

async function _runAnalyzeFull({ imageId, userId, imageData, analysisVersion, stepResults }) {
  const { FormData, Blob } = globalThis;
  if (!imageData) {
    stepResults.cleanup = { status: "failed", errorCode: "ANALYZE_FULL_IMAGE_BUFFER_MISSING", data: {} };
    throw new Error("ANALYZE_FULL_IMAGE_BUFFER_MISSING");
  }
  const formData = new FormData();
  const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: "application/octet-stream" });
  formData.append("image", blob, `image-${imageId}.bin`);
  const profile = process.env.AI_ANALYSIS_PROFILE || "full";
  const device = process.env.AI_DEVICE || "auto";
  formData.append("profile", profile);
  formData.append("device", device);
  formData.append("image_id", String(imageId));
  const response = await withAiSlot(() =>
    axios.post(`${PYTHON_SERVICE_URL}/analyze_full`, formData, {
      timeout: ANALYZE_FULL_TIMEOUT_MS,
      maxBodyLength: Infinity,
      headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
    }),
  );
  const body = response.data || {};
  if (body.status === "failed") {
    const err = new Error(body.errors?.[0]?.message || "ANALYZE_FULL_FAILED");
    err.code = body.errors?.[0]?.code || "ANALYZE_FULL_FAILED";
    throw err;
  }
  _applyAdapterFromModules(imageId, userId, analysisVersion, body, stepResults);
}

function _applyAdapterFromModules(imageId, userId, analysisVersion, body, stepResults) {
  const modules = body.modules || {};
  const round2 = (v) => (typeof v === "number" ? Number(v.toFixed(2)) : null);

  if (modules.caption?.status === "success" && modules.caption.data) {
    const d = modules.caption.data;
    const captionText = typeof d.caption === "string" ? d.caption : (typeof d.text === "string" ? d.text : "");
    const keywords = Array.isArray(d.keywords) ? d.keywords : [];
    upsertMediaCaptionsForAnalysis({
      mediaId: imageId,
      caption: captionText,
      keywords,
      analysisVersion,
    });
    stepResults.caption = {
      status: "completed",
      errorCode: null,
      data: { caption: captionText, keywords },
    };
  } else {
    stepResults.caption = { status: modules.caption?.status || "failed", errorCode: modules.caption?.error?.code || null, data: {} };
  }

  if (modules.ocr?.status === "success" && modules.ocr.data?.blocks) {
    upsertMediaTextBlocksOcrForAnalysis(imageId, modules.ocr.data.blocks, analysisVersion);
    stepResults.ocr = { status: "completed", errorCode: null, data: { blocks: modules.ocr.data.blocks } };
  } else {
    stepResults.ocr = { status: modules.ocr?.status || "failed", errorCode: modules.ocr?.error?.code || null, data: {} };
  }

  if (modules.quality?.status === "success" && modules.quality.data) {
    const d = modules.quality.data;
    cleanupModel.updateMediaCleanupMetrics(imageId, {
      imagePhash: d.hashes?.phash ?? null,
      imageDhash: d.hashes?.dhash ?? null,
      aestheticScore: round2(d.aesthetic_score ?? null),
      sharpnessScore: round2(d.sharpness_score ?? null),
    });
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
    stepResults.cleanup = { status: modules.quality?.status || "failed", errorCode: modules.quality?.error?.code || null, data: {} };
  }

  if (modules.embedding?.status === "success" && modules.embedding.data?.vector) {
    try {
      upsertMediaEmbedding({ imageId, vector: modules.embedding.data.vector, modelId: modules.embedding.data.model || "siglip2" });
    } catch (e) {
      logger.warn({ message: "analyze_full adapter: upsertMediaEmbedding failed", details: { imageId, error: e.message } });
    }
  }
  if ((modules.quality?.status === "success" || modules.embedding?.status === "success") && userId) {
    scheduleUserRebuild(userId);
  }

  if (modules.person?.status === "success" && modules.person.data) {
    const d = modules.person.data;
    const faceCount = d.face_count ?? 0;
    const personCount = d.person_count ?? 0;
    const faces = Array.isArray(d.faces) ? d.faces : [];
    const summary = d.summary || {};
    const expressions = summary.expressions || [];
    const ages = summary.ages || [];
    const genders = summary.genders || [];
    const primaryFace = faces[0];
    updateMediaSearchMetadata({
      imageId,
      faceCount,
      personCount,
      expressionTags: expressions.join(","),
      ageTags: ages.join(","),
      genderTags: genders.join(","),
      primaryExpressionConfidence: primaryFace?.expression_confidence ?? null,
      primaryFaceQuality: primaryFace?.quality_score ?? null,
      rebuildSearchArtifacts: false,
    });
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
      insertFaceEmbeddings(imageId, toInsert, analysisVersion);
    }
    stepResults.face = {
      status: "completed",
      errorCode: null,
      data: {
        faceCount,
        personCount,
        primaryFaceQuality: primaryFace?.quality_score ?? null,
        primaryExpression: expressions[0],
        primaryExpressionConfidence: primaryFace?.expression_confidence ?? null,
        hasClusterableFace: highQualityFaces.length > 0,
      },
    };
    if (userId) scheduleUserClustering(userId);
  } else {
    stepResults.face = { status: modules.person?.status || "failed", errorCode: modules.person?.error?.code || null, data: {} };
  }
}

async function finalizeMediaAnalysis({ imageId, analysisVersion, stepResults }) {
  const faceData = stepResults.face?.data || {};
  const cleanupData = stepResults.cleanup?.data || {};
  const captionData = stepResults.caption?.data || {};
  const ocrData = stepResults.ocr?.data || {};

  finalizeMediaAnalysisInModel({
    mediaId: imageId,
    analysisVersion,
    faceData,
    cleanupData,
    captionData,
    ocrData,
  });

  await rebuildMediaSearchDoc(imageId);
}

module.exports = {
  processMediaAnalysis,
};
