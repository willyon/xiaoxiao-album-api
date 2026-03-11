/*
 * @Description: 媒体智能分析主链 Ingestor（Phase 0 + Phase 1）
 * - Phase 0：建立骨架，支持 video 占位完成
 * - Phase 1：迁移 face + cleanup，统一 finalize
 */

const logger = require("../utils/logger");
const storageService = require("../services/storageService");
const imageUnderstandingService = require("../services/imageUnderstandingService");
const { updateImageSearchMetadata, insertFaceEmbeddings, rebuildMediaSearchDoc } = require("../models/imageModel");
const { runCleanupAnalysisCore } = require("../services/cleanupAnalysisService");
const { updateProgressOnce } = require("../services/imageProcessingProgressService");
const axios = require("axios");
const { withAiSlot } = require("../services/aiConcurrencyLimiter");
const { db } = require("../services/database");
const {
  markMediaAnalysisRunning,
  markMediaAnalysisFailed,
  finalizeMediaAnalysis: finalizeMediaAnalysisInModel,
} = require("../models/mediaAnalysisModel");

const PYTHON_SERVICE_URL =
  process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

const ANALYSIS_VERSION = process.env.ANALYSIS_VERSION || "1.0";

/**
 * 规范化来自 Python 服务的错误对象：
 * - 若有 error.response.data.error_code / error_message，则透传到 error.code / error.message
 * - Axios 超时（ECONNABORTED）统一映射为 AI_TIMEOUT
 * 返回最终用于写入 stepResults.xxx.errorCode 的 code
 */
function normalizePythonError(error, fallbackCode) {
  // Axios 超时优先映射为 AI_TIMEOUT
  if (axios.isAxiosError && axios.isAxiosError(error) && error.code === "ECONNABORTED") {
    error.code = "AI_TIMEOUT";
    if (!error.message) {
      error.message = "AI request timeout";
    }
    return error.code;
  }

  // 透传 Python 统一错误码结构
  const pythonBody = error?.response?.data;
  if (pythonBody && typeof pythonBody === "object") {
    const bodyDetail = pythonBody.detail || pythonBody;
    const codeFromBody = bodyDetail.error_code || bodyDetail.code;
    const msgFromBody = bodyDetail.error_message || bodyDetail.message;
    if (codeFromBody) {
      error.code = codeFromBody;
    }
    if (msgFromBody && !error.message) {
      error.message = msgFromBody;
    }
  }

  return error.code || fallbackCode;
}

function resolveCapabilities() {
  const profile = (process.env.AI_ANALYSIS_PROFILE || "").toLowerCase();

  // profile 默认组合
  let defaults = {
    face: true,
    caption: true,
    object: true,
    scene: true,
    ocr: false,
  };

  if (profile === "basic") {
    defaults = {
      face: false,
      caption: false,
      object: true,
      scene: false,
      ocr: false,
    };
  } else if (profile === "standard") {
    defaults = {
      face: true,
      caption: true,
      object: true,
      scene: true,
      ocr: true,
    };
  } else if (profile === "enhanced") {
    defaults = {
      face: true,
      caption: true,
      object: true,
      scene: true,
      ocr: true,
    };
  }

  // 显式 ENABLE_* 覆盖 profile 默认
  const face = process.env.ENABLE_FACE_ANALYSIS
    ? process.env.ENABLE_FACE_ANALYSIS === "true"
    : defaults.face;
  const caption = process.env.ENABLE_CAPTION
    ? process.env.ENABLE_CAPTION !== "false"
    : defaults.caption;
  const object = process.env.ENABLE_OBJECT_DETECTION
    ? process.env.ENABLE_OBJECT_DETECTION !== "false"
    : defaults.object;
  const scene = process.env.ENABLE_SCENE_ANALYSIS
    ? process.env.ENABLE_SCENE_ANALYSIS === "true"
    : defaults.scene;
  const ocr = process.env.ENABLE_OCR
    ? process.env.ENABLE_OCR === "true"
    : defaults.ocr;

  return { face, caption, object, scene, ocr };
}

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

    const { imageData, storageKey } = await _loadImageBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName });
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
      object: { status: "pending", errorCode: null, data: {} },
      scene: { status: "pending", errorCode: null, data: {} },
      ocr: { status: "pending", errorCode: null, data: {} },
    };

    // Phase 1：按顺序执行 face → cleanup
    await _runFaceAnalysis({ imageId, userId, imageData, storageKey, analysisVersion, stepResults });
    await _runCleanupAnalysis({ imageId, userId, imageData, analysisVersion, stepResults, highResStorageKey, originalStorageKey });

    // Phase 2：接入 caption + object（在已有 buffer 基础上继续复用 Python 服务）
    await _runCaptionAnalysis({ imageId, userId, imageData, analysisVersion, stepResults });
    await _runObjectAnalysis({ imageId, userId, imageData, analysisVersion, stepResults });

    // Scene：独立场景识别接口（可与 object 协同使用）
    await _runSceneAnalysis({ imageId, userId, imageData, analysisVersion, stepResults });

    // Phase 3：接入 OCR
    await _runOcrAnalysis({ imageId, userId, imageData, analysisVersion, stepResults });

    await finalizeMediaAnalysis({ imageId, userId, analysisVersion, stepResults });

    if (sessionId) {
      await updateProgressOnce({ sessionId, status: "aiDoneCount", dedupeKey: imageId });
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

async function _loadImageBuffer({ highResStorageKey, originalStorageKey, imageId, userId, fileName }) {
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
  await updateImageSearchMetadata({ imageId, analysisVersion });
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

async function _runFaceAnalysis({ imageId, userId, imageData, storageKey, analysisVersion, stepResults }) {
  const { face: enabledFace } = resolveCapabilities();
  if (!enabledFace) {
    stepResults.face = {
      status: "disabled",
      errorCode: null,
      data: {},
    };
    return;
  }
  try {
    const faceResult = await imageUnderstandingService.processImageFaceOnly({
      imageData,
      imageId,
      storageKey,
    });

    const { faceCount, personCount, expressionTags, ageTags, genderTags, primaryExpressionConfidence, primaryFaceQuality, faces } =
      faceResult || {};

    await updateImageSearchMetadata({
      imageId,
      faceCount,
      personCount,
      expressionTags,
      ageTags,
      genderTags,
      primaryExpressionConfidence,
      primaryFaceQuality,
    });

    if (faces && faces.length) {
      const highQualityFaces = faces.filter((face) => face.is_high_quality);
      if (highQualityFaces.length > 0) {
        await insertFaceEmbeddings(imageId, highQualityFaces, analysisVersion);
      }
    }

    const hasClusterableFace = Array.isArray(faces) && faces.some((f) => f.is_high_quality);

    stepResults.face = {
      status: "completed",
      errorCode: null,
      data: {
        faceCount: faceCount ?? 0,
        personCount: personCount ?? 0,
        primaryFaceQuality: primaryFaceQuality ?? null,
        primaryExpression: expressionTags && expressionTags[0],
        primaryExpressionConfidence: primaryExpressionConfidence ?? null,
        hasClusterableFace,
      },
    };
  } catch (error) {
    logger.error({
      message: "runFaceAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    stepResults.face = {
      status: "failed",
      errorCode: error.code || "FACE_ANALYSIS_FAILED",
      data: {},
    };
    throw error;
  }
}

async function _runCleanupAnalysis({ imageId, userId, imageData, analysisVersion, stepResults, highResStorageKey, originalStorageKey }) {
  try {
    const buffer = imageData;
    if (!buffer) {
      logger.warn({
        message: "cleanup.load_buffer.failed",
        details: { imageId, userId, highResStorageKey, originalStorageKey },
      });
      stepResults.cleanup = {
        status: "failed",
        errorCode: "CLEANUP_IMAGE_BUFFER_MISSING",
        data: {},
      };
      throw new Error("CLEANUP_IMAGE_BUFFER_MISSING");
    }

    const coreResult = await runCleanupAnalysisCore({ imageId, userId, buffer });
    if (!coreResult.ok) {
      stepResults.cleanup = {
        status: "failed",
        errorCode: coreResult.errorCode || "CLEANUP_ANALYSIS_FAILED",
        data: {},
      };
      throw new Error(coreResult.errorCode || "CLEANUP_ANALYSIS_FAILED");
    }

    const analysis = coreResult.analysis || {};

    stepResults.cleanup = {
      status: "completed",
      errorCode: null,
      data: {
        phash: analysis?.hashes?.phash ?? null,
        dhash: analysis?.hashes?.dhash ?? null,
        aestheticScore: typeof analysis.aesthetic_score === "number" ? Number(analysis.aesthetic_score.toFixed(2)) : null,
        sharpnessScore: typeof analysis.sharpness_score === "number" ? Number(analysis.sharpness_score.toFixed(2)) : null,
        embeddingModel: coreResult.embeddingModel,
        embeddingFailed: coreResult.embeddingFailed,
      },
    };
  } catch (error) {
    logger.error({
      message: "runCleanupAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    stepResults.cleanup = {
      status: "failed",
      errorCode: error.code || "CLEANUP_ANALYSIS_FAILED",
      data: {},
    };
    throw error;
  }
}

async function _runCaptionAnalysis({ imageId, userId, imageData, analysisVersion, stepResults }) {
  const { caption: enabledCaption } = resolveCapabilities();
  if (!enabledCaption) {
    stepResults.caption = {
      status: "disabled",
      errorCode: null,
      data: {},
    };
    return;
  }

  const { FormData, Blob } = globalThis;

  try {
    if (!imageData) {
      stepResults.caption = {
        status: "failed",
        errorCode: "CAPTION_IMAGE_BUFFER_MISSING",
        data: {},
      };
      throw new Error("CAPTION_IMAGE_BUFFER_MISSING");
    }

    const formData = new FormData();
    const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: "application/octet-stream" });
    formData.append("image", blob, `image-${imageId}.bin`);

    const profile = process.env.AI_ANALYSIS_PROFILE || "basic";
    const device = process.env.AI_DEVICE || "auto";
    formData.append("profile", profile);
    formData.append("device", device);

    const response = await withAiSlot(() =>
      axios.post(`${PYTHON_SERVICE_URL}/analyze_caption`, formData, {
        timeout: Number(process.env.CAPTION_ANALYSIS_TIMEOUT || 300000),
        maxBodyLength: Infinity,
        headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
      }),
    );

    const { caption, keywords } = response.data || {};

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM media_captions WHERE media_id = ? AND source_type = 'image'").run(imageId);
      db.prepare(
        `
        INSERT INTO media_captions (media_id, source_type, caption, keywords_json, analysis_version, created_at)
        VALUES (?, 'image', ?, ?, ?, ?)
      `,
      ).run(imageId, caption || "", JSON.stringify(keywords || []), analysisVersion, Date.now());
    });
    tx();

    stepResults.caption = {
      status: "completed",
      errorCode: null,
      data: {
        caption: caption || "",
        keywords: Array.isArray(keywords) ? keywords : [],
      },
    };
  } catch (error) {
    logger.error({
      message: "runCaptionAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    stepResults.caption = {
      status: "failed",
      errorCode: normalizePythonError(error, "CAPTION_ANALYSIS_FAILED"),
      data: {},
    };
    throw error;
  }
}

async function _runObjectAnalysis({ imageId, userId, imageData, analysisVersion, stepResults }) {
  const { object: enabledObject } = resolveCapabilities();
  if (!enabledObject) {
    stepResults.object = {
      status: "disabled",
      errorCode: null,
      data: {},
    };
    return;
  }

  const { FormData, Blob } = globalThis;

  try {
    if (!imageData) {
      stepResults.object = {
        status: "failed",
        errorCode: "OBJECT_IMAGE_BUFFER_MISSING",
        data: {},
      };
      throw new Error("OBJECT_IMAGE_BUFFER_MISSING");
    }

    const formData = new FormData();
    const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: "application/octet-stream" });
    formData.append("image", blob, `image-${imageId}.bin`);

    const profile = process.env.AI_ANALYSIS_PROFILE || "basic";
    const device = process.env.AI_DEVICE || "auto";
    formData.append("profile", profile);
    formData.append("device", device);

    const response = await withAiSlot(() =>
      axios.post(`${PYTHON_SERVICE_URL}/analyze_objects`, formData, {
        timeout: Number(process.env.OBJECT_ANALYSIS_TIMEOUT || 300000),
        maxBodyLength: Infinity,
        headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
      }),
    );

    const objects = Array.isArray(response.data?.objects) ? response.data.objects : [];

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM media_objects WHERE media_id = ? AND source_type = 'image'").run(imageId);
      const insertStmt = db.prepare(
        `
        INSERT INTO media_objects (media_id, source_type, label, confidence, bbox, analysis_version, created_at)
        VALUES (?, 'image', ?, ?, ?, ?, ?)
      `,
      );
      for (const obj of objects) {
        insertStmt.run(
          imageId,
          obj.label || "",
          typeof obj.confidence === "number" ? obj.confidence : null,
          JSON.stringify(obj.bbox ?? null),
          analysisVersion,
          Date.now(),
        );
      }
    });
    tx();

    stepResults.object = {
      status: "completed",
      errorCode: null,
      data: {
        objects,
      },
    };
  } catch (error) {
    logger.error({
      message: "runObjectAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    stepResults.object = {
      status: "failed",
      errorCode: normalizePythonError(error, "OBJECT_ANALYSIS_FAILED"),
      data: {},
    };
    throw error;
  }
}

async function _runOcrAnalysis({ imageId, userId, imageData, analysisVersion, stepResults }) {
  const { ocr: enabledOcr } = resolveCapabilities();
  if (!enabledOcr) {
    stepResults.ocr = {
      status: "disabled",
      errorCode: null,
      data: {},
    };
    return;
  }

  const { FormData, Blob } = globalThis;

  try {
    if (!imageData) {
      stepResults.ocr = {
        status: "failed",
        errorCode: "OCR_IMAGE_BUFFER_MISSING",
        data: {},
      };
      throw new Error("OCR_IMAGE_BUFFER_MISSING");
    }

    const formData = new FormData();
    const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: "application/octet-stream" });
    formData.append("image", blob, `image-${imageId}.bin`);

    const profile = process.env.AI_ANALYSIS_PROFILE || "basic";
    const device = process.env.AI_DEVICE || "auto";
    formData.append("profile", profile);
    formData.append("device", device);

    const response = await withAiSlot(() =>
      axios.post(`${PYTHON_SERVICE_URL}/ocr`, formData, {
        timeout: Number(process.env.OCR_ANALYSIS_TIMEOUT || 300000),
        maxBodyLength: Infinity,
        headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
      }),
    );

    const blocks = Array.isArray(response.data) ? response.data : Array.isArray(response.data?.blocks) ? response.data.blocks : [];

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM media_text_blocks WHERE media_id = ? AND source_type = 'ocr'").run(imageId);
      const insertStmt = db.prepare(
        `
        INSERT INTO media_text_blocks (media_id, source_type, text, bbox, confidence, analysis_version, created_at)
        VALUES (?, 'ocr', ?, ?, ?, ?, ?)
      `,
      );
      for (const block of blocks) {
        insertStmt.run(
          imageId,
          block.text || "",
          JSON.stringify(block.bbox ?? null),
          block.confidence ?? null,
          analysisVersion,
          Date.now(),
        );
      }
    });
    tx();

    stepResults.ocr = {
      status: "completed",
      errorCode: null,
      data: {
        blocks,
      },
    };
  } catch (error) {
    logger.error({
      message: "runOcrAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    stepResults.ocr = {
      status: "failed",
      errorCode: normalizePythonError(error, "OCR_ANALYSIS_FAILED"),
      data: {},
    };
    throw error;
  }
}

async function _runSceneAnalysis({ imageId, userId, imageData, analysisVersion, stepResults }) {
  const { scene: enabledScene } = resolveCapabilities();
  if (!enabledScene) {
    stepResults.scene = {
      status: "disabled",
      errorCode: null,
      data: {},
    };
    return;
  }

  const { FormData, Blob } = globalThis;

  try {
    if (!imageData) {
      stepResults.scene = {
        status: "failed",
        errorCode: "SCENE_IMAGE_BUFFER_MISSING",
        data: {},
      };
      throw new Error("SCENE_IMAGE_BUFFER_MISSING");
    }

    const formData = new FormData();
    const blob = imageData instanceof Blob ? imageData : new Blob([imageData], { type: "application/octet-stream" });
    formData.append("image", blob, `image-${imageId}.bin`);

    const profile = process.env.AI_ANALYSIS_PROFILE || "basic";
    const device = process.env.AI_DEVICE || "auto";
    formData.append("profile", profile);
    formData.append("device", device);

    const response = await withAiSlot(() =>
      axios.post(`${PYTHON_SERVICE_URL}/analyze_scene`, formData, {
        timeout: Number(process.env.SCENE_ANALYSIS_TIMEOUT || 300000),
        maxBodyLength: Infinity,
        headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
      }),
    );

    const primaryScene = response.data?.primary_scene || null;
    const sceneTags = Array.isArray(response.data?.scene_tags) ? response.data.scene_tags : [];
    const sceneConfidence =
      typeof response.data?.confidence === "number" && !Number.isNaN(response.data.confidence)
        ? response.data.confidence
        : null;
    let environment = response.data?.environment || null;

    // 简单环境推断：若未显式返回，则根据 primary_scene 做一次粗分类
    if (!environment && typeof primaryScene === "string") {
      const v = primaryScene.toLowerCase();
      if (v.includes("indoor") || v.includes("room") || v.includes("home") || v.includes("office")) {
        environment = "indoor";
      } else if (v.includes("outdoor") || v.includes("beach") || v.includes("mountain") || v.includes("street") || v.includes("park")) {
        environment = "outdoor";
      }
    }

    db.prepare(
      `
      INSERT INTO media_analysis (media_id, analysis_status, analysis_version, scene_primary, environment)
      VALUES (?, 'pending', ?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET
        scene_primary = COALESCE(?, media_analysis.scene_primary),
        environment = COALESCE(?, media_analysis.environment)
    `,
    ).run(imageId, analysisVersion, primaryScene, environment, primaryScene, environment);

    stepResults.scene = {
      status: "completed",
      errorCode: null,
      data: {
        primaryScene,
        sceneTags,
        confidence: sceneConfidence,
        environment: environment || null,
      },
    };
  } catch (error) {
    logger.error({
      message: "runSceneAnalysis failed",
      details: { imageId, userId, error: error.message },
    });
    stepResults.scene = {
      status: "failed",
      errorCode: normalizePythonError(error, "SCENE_ANALYSIS_FAILED"),
      data: {},
    };
    throw error;
  }
}

async function finalizeMediaAnalysis({ imageId, analysisVersion, stepResults }) {
  const faceData = stepResults.face?.data || {};
  const cleanupData = stepResults.cleanup?.data || {};
  const captionData = stepResults.caption?.data || {};
  const ocrData = stepResults.ocr?.data || {};
  const sceneData = stepResults.scene?.data || {};

  // 基于启用能力集合 + 各步骤 status 统一判定是否可视为 done；
  // 任一启用能力步骤为 failed 或 pending 则视为失败，抛出错误交由外层处理（markMediaAnalysisFailed + BullMQ 重试）。
  const { face: enabledFace, caption: enabledCaption, object: enabledObject, scene: enabledScene, ocr: enabledOcr } =
    resolveCapabilities();

  const requiredSteps = [
    { key: "cleanup", enabled: true }, // cleanup 始终视为基础能力，当前阶段默认启用
    { key: "face", enabled: enabledFace },
    { key: "caption", enabled: enabledCaption },
    { key: "object", enabled: enabledObject },
    { key: "scene", enabled: enabledScene },
    { key: "ocr", enabled: enabledOcr },
  ];

  const enabledStepStatuses = requiredSteps
    .filter((s) => s.enabled)
    .map((s) => ({ key: s.key, status: stepResults[s.key]?.status || "pending" }));

  const failedSteps = enabledStepStatuses.filter((s) => s.status === "failed").map((s) => s.key);
  if (failedSteps.length > 0) {
    const err = new Error(`MEDIA_ANALYSIS_STEP_FAILED:${failedSteps.join(",")}`);
    err.code = "MEDIA_ANALYSIS_STEP_FAILED";
    throw err;
  }

  const incompleteSteps = enabledStepStatuses.filter(
    (s) => s.status !== "completed" && s.status !== "disabled" && s.status !== "skipped",
  );
  if (incompleteSteps.length > 0) {
    const err = new Error(`MEDIA_ANALYSIS_STEP_INCOMPLETE:${incompleteSteps.map((s) => s.key).join(",")}`);
    err.code = "MEDIA_ANALYSIS_STEP_INCOMPLETE";
    throw err;
  }

  finalizeMediaAnalysisInModel({
    mediaId: imageId,
    analysisVersion,
    faceData,
    cleanupData,
    captionData,
    sceneData,
    ocrData,
  });

  await rebuildMediaSearchDoc(imageId);
}

module.exports = {
  processMediaAnalysis,
};

