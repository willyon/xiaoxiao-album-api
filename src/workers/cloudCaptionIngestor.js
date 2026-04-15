/*
 * @Description: 云 Caption 异步队列的实际处理逻辑（与 cloudCaptionWorker 分离，对齐其它 *Ingestor 形态）
 */

const { UnrecoverableError } = require("bullmq");
const logger = require("../utils/logger");
const { bullMqWillRetryAfterThisFailure } = require("../utils/queuePipelineLifecycle");
const storageService = require("../services/storageService");
const { updateAnalysisStatusCloud, upsertMediaAiFieldsForAnalysis, rebuildMediaSearchDoc } = require("../models/mediaModel");
const { withAiSlot } = require("../services/aiConcurrencyLimiter");
const { getCloudConfigForAnalysis } = require("../services/cloudModelService");

const PYTHON_SERVICE_URL =
  process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

const ANALYZE_IMAGE_TIMEOUT_MS = Number(process.env.ANALYZE_IMAGE_TIMEOUT_MS || 120000);
const ANALYZE_VIDEO_TIMEOUT_MS = Number(process.env.ANALYZE_VIDEO_TIMEOUT_MS || 600000);

/** 为 fetch 提供超时，避免 HTTP 请求长期挂起（Node 18+ 优先 AbortSignal.timeout） */
function cloudCaptionFetchSignal(timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 120000);
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  if (typeof t.unref === "function") t.unref();
  return controller.signal;
}

function buildCaptionForDb(capData) {
  return {
    description: typeof capData.description === "string" ? capData.description : undefined,
    keywords: Array.isArray(capData.keywords) ? capData.keywords : undefined,
    subjectTags: Array.isArray(capData.subject_tags) ? capData.subject_tags : undefined,
    actionTags: Array.isArray(capData.action_tags) ? capData.action_tags : undefined,
    sceneTags: Array.isArray(capData.scene_tags) ? capData.scene_tags : undefined,
    ocr: typeof capData.ocr === "string" ? capData.ocr : undefined,
    faceCount:
      typeof capData.face_count === "number" && Number.isFinite(capData.face_count) ? capData.face_count : undefined,
    personCount:
      typeof capData.person_count === "number" && Number.isFinite(capData.person_count)
        ? capData.person_count
        : undefined,
  };
}

/**
 * @param {import("bullmq").Job} job
 */
async function processCloudCaptionJob(job) {
  const { mediaId, userId, highResStorageKey, originalStorageKey, mediaType } = job.data || {};
  if (!mediaId) {
    logger.warn({ message: "cloudCaptionIngestor: job missing mediaId", details: { jobId: job.id, data: job.data } });
    return;
  }

  const type = mediaType === "video" ? "video" : "image";

  try {
    if (type === "video") {
      let videoPath = null;
      if (originalStorageKey) {
        videoPath = await storageService.getLocalFilePath(originalStorageKey);
      }
      if (!videoPath && highResStorageKey) {
        videoPath = await storageService.getLocalFilePath(highResStorageKey);
      }
      if (!videoPath) {
        throw new UnrecoverableError("CLOUD_CAPTION_VIDEO_PATH_NOT_FOUND");
      }

      const device = process.env.AI_DEVICE || "auto";
      const cloudConfig = getCloudConfigForAnalysis(userId);
      const modules = "caption";

      const payload = {
        video_path: videoPath,
        device,
        image_id: String(mediaId),
        cloud_config: cloudConfig,
        modules,
      };

      const response = await withAiSlot(() =>
        fetch(`${PYTHON_SERVICE_URL}/analyze_video`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: cloudCaptionFetchSignal(ANALYZE_VIDEO_TIMEOUT_MS),
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        const errMsg = `CLOUD_CAPTION_VIDEO_HTTP_${response.status}: ${text.slice(0, 200)}`;
        if (response.status >= 500 || response.status === 429) {
          throw new Error(errMsg);
        }
        throw new UnrecoverableError(errMsg);
      }

      const body = await response.json();
      const modulesResult = body?.data || {};
      const captionModule = modulesResult.caption || {};
      const capStatus = captionModule.status;
      const capData = captionModule.data;

      if (capStatus === "success" && capData) {
        upsertMediaAiFieldsForAnalysis({
          mediaId,
          caption: buildCaptionForDb(capData),
        });

        rebuildMediaSearchDoc(mediaId);
        updateAnalysisStatusCloud(mediaId, "success");
        logger.info({
          message: "cloudCaptionIngestor.video.completed",
          details: { mediaId, userId },
        });
      } else {
        const errorCode = captionModule?.error?.code || "CLOUD_CAPTION_VIDEO_FAILED";
        logger.warn({
          message: "cloudCaptionIngestor.video.caption_failed",
          details: { mediaId, userId, status: capStatus, errorCode },
        });
        throw new Error(String(errorCode));
      }
    } else {
      let localPath = null;
      if (highResStorageKey) {
        localPath = await storageService.getLocalFilePath(highResStorageKey);
      }
      if (!localPath && originalStorageKey) {
        localPath = await storageService.getLocalFilePath(originalStorageKey);
      }

      const { FormData, Blob } = globalThis;
      const formData = new FormData();
      if (localPath) {
        formData.append("image_path", localPath);
      } else if (originalStorageKey) {
        const buf = await storageService.storage.getFileBuffer(originalStorageKey);
        if (!buf) {
          throw new UnrecoverableError("CLOUD_CAPTION_MEDIA_FILE_NOT_FOUND");
        }
        const blob = new Blob([buf], { type: "application/octet-stream" });
        formData.append("image", blob, `image-${mediaId}.bin`);
      } else {
        throw new UnrecoverableError("CLOUD_CAPTION_NO_STORAGE_KEY");
      }

      const device = process.env.AI_DEVICE || "auto";
      formData.append("device", device);
      formData.append("image_id", String(mediaId));
      const cloudConfig = getCloudConfigForAnalysis(userId);
      if (cloudConfig) {
        formData.append("cloud_config", JSON.stringify(cloudConfig));
      }

      const modules = "caption";

      const response = await withAiSlot(() =>
        fetch(`${PYTHON_SERVICE_URL}/analyze_image?modules=${encodeURIComponent(modules)}`, {
          method: "POST",
          body: formData,
          signal: cloudCaptionFetchSignal(ANALYZE_IMAGE_TIMEOUT_MS),
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        const errMsg = `CLOUD_CAPTION_HTTP_${response.status}: ${text.slice(0, 200)}`;
        if (response.status >= 500 || response.status === 429) {
          throw new Error(errMsg);
        }
        throw new UnrecoverableError(errMsg);
      }

      const body = await response.json();
      const modulesResult = body?.data || {};
      const captionModule = modulesResult.caption || {};
      const capStatus = captionModule.status;
      const capData = captionModule.data;

      if (capStatus === "success" && capData) {
        upsertMediaAiFieldsForAnalysis({
          mediaId,
          caption: buildCaptionForDb(capData),
        });

        rebuildMediaSearchDoc(mediaId);
        updateAnalysisStatusCloud(mediaId, "success");
        logger.info({
          message: "cloudCaptionIngestor.completed",
          details: { mediaId, userId },
        });
      } else {
        const errorCode = captionModule?.error?.code || "CLOUD_CAPTION_FAILED";
        logger.warn({
          message: "cloudCaptionIngestor.caption_failed",
          details: { mediaId, userId, status: capStatus, errorCode },
        });
        throw new Error(String(errorCode));
      }
    }
  } catch (error) {
    const willRetry = bullMqWillRetryAfterThisFailure(job, error);
    if (!willRetry) {
      updateAnalysisStatusCloud(mediaId, "failed");
    }
    logger.error({
      message: "cloudCaptionIngestor.error",
      details: { mediaId, userId, error: error?.message, willRetry },
    });
    throw error;
  }
}

module.exports = {
  processCloudCaptionJob,
};
