const { Worker } = require("bullmq");
const IORedis = require("ioredis");

const logger = require("../utils/logger");
const storageService = require("../services/storageService");
const { updateAnalysisStatusCloud, upsertMediaAiFieldsForAnalysis, rebuildMediaSearchDoc } = require("../models/mediaModel");
const { withAiSlot } = require("../services/aiConcurrencyLimiter");
const { getCloudConfigForAnalysis } = require("../services/cloudModelService");

const PYTHON_SERVICE_URL =
  process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

const connection = new IORedis({ maxRetriesPerRequest: null });
const QUEUE_NAME = process.env.CLOUD_CAPTION_QUEUE_NAME || "cloudCaptionQueue";

const ANALYZE_IMAGE_TIMEOUT_MS = Number(process.env.ANALYZE_IMAGE_TIMEOUT_MS || 120000);
const ANALYZE_VIDEO_TIMEOUT_MS = Number(process.env.ANALYZE_VIDEO_TIMEOUT_MS || 600000);

async function processJob(job) {
  const { mediaId, userId, highResStorageKey, originalStorageKey, mediaType } = job.data || {};
  if (!mediaId) {
    logger.warn({ message: "cloudCaptionWorker: job missing mediaId", details: { jobId: job.id, data: job.data } });
    return;
  }

  updateAnalysisStatusCloud(mediaId, "running");

  const type = mediaType === "video" ? "video" : "image";

  try {
    // 复用与 mediaAnalysisIngestor 一致的本地路径解析逻辑（简化版：优先走本地路径）
    if (type === "video") {
      let videoPath = null;
      if (originalStorageKey) {
        videoPath = await storageService.getLocalFilePath(originalStorageKey);
      }
      if (!videoPath && highResStorageKey) {
        videoPath = await storageService.getLocalFilePath(highResStorageKey);
      }
      if (!videoPath) {
        throw new Error("CLOUD_CAPTION_VIDEO_PATH_NOT_FOUND");
      }

      const device = process.env.AI_DEVICE || "auto";
      const cloudConfig = getCloudConfigForAnalysis();
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
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`CLOUD_CAPTION_VIDEO_HTTP_${response.status}: ${text.slice(0, 200)}`);
      }

      const body = await response.json();
      const modulesResult = body?.data || {};
      const captionModule = modulesResult.caption || {};
      const capStatus = captionModule.status;
      const capData = captionModule.data;

      if (capStatus === "success" && capData) {
        const captionForDb = {
          description: typeof capData.description === "string" ? capData.description : undefined,
          keywords: Array.isArray(capData.keywords) ? capData.keywords : undefined,
          subjectTags: Array.isArray(capData.subject_tags) ? capData.subject_tags : undefined,
          actionTags: Array.isArray(capData.action_tags) ? capData.action_tags : undefined,
          sceneTags: Array.isArray(capData.scene_tags) ? capData.scene_tags : undefined,
          ocr: typeof capData.ocr === "string" ? capData.ocr : undefined,
          faceCount:
            typeof capData.face_count === "number" && Number.isFinite(capData.face_count)
              ? capData.face_count
              : undefined,
          personCount:
            typeof capData.person_count === "number" && Number.isFinite(capData.person_count)
              ? capData.person_count
              : undefined,
        };

        upsertMediaAiFieldsForAnalysis({
          mediaId,
          caption: captionForDb,
        });

        rebuildMediaSearchDoc(mediaId);
        updateAnalysisStatusCloud(mediaId, "success");
        logger.info({
          message: "cloudCaptionWorker.video.completed",
          details: { mediaId, userId },
        });
      } else {
        const errorCode = captionModule?.error?.code || "CLOUD_CAPTION_VIDEO_FAILED";
        updateAnalysisStatusCloud(mediaId, "failed");
        logger.warn({
          message: "cloudCaptionWorker.video.caption_failed",
          details: { mediaId, userId, status: capStatus, errorCode },
        });
        throw new Error(String(errorCode));
      }
    } else {
      // 图片：沿用原有 analyze_image?modules=caption 逻辑
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
          throw new Error("CLOUD_CAPTION_MEDIA_FILE_NOT_FOUND");
        }
        const blob = new Blob([buf], { type: "application/octet-stream" });
        formData.append("image", blob, `image-${mediaId}.bin`);
      } else {
        throw new Error("CLOUD_CAPTION_NO_STORAGE_KEY");
      }

      const device = process.env.AI_DEVICE || "auto";
      formData.append("device", device);
      formData.append("image_id", String(mediaId));

      const modules = "caption";

      const response = await withAiSlot(() =>
        fetch(`${PYTHON_SERVICE_URL}/analyze_image?modules=${encodeURIComponent(modules)}`, {
          method: "POST",
          body: formData,
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`CLOUD_CAPTION_HTTP_${response.status}: ${text.slice(0, 200)}`);
      }

      const body = await response.json();
      const modulesResult = body?.data || {};
      const captionModule = modulesResult.caption || {};
      const capStatus = captionModule.status;
      const capData = captionModule.data;

      if (capStatus === "success" && capData) {
        const captionForDb = {
          description: typeof capData.description === "string" ? capData.description : undefined,
          keywords: Array.isArray(capData.keywords) ? capData.keywords : undefined,
          subjectTags: Array.isArray(capData.subject_tags) ? capData.subject_tags : undefined,
          actionTags: Array.isArray(capData.action_tags) ? capData.action_tags : undefined,
          sceneTags: Array.isArray(capData.scene_tags) ? capData.scene_tags : undefined,
          ocr: typeof capData.ocr === "string" ? capData.ocr : undefined,
          faceCount:
            typeof capData.face_count === "number" && Number.isFinite(capData.face_count)
              ? capData.face_count
              : undefined,
          personCount:
            typeof capData.person_count === "number" && Number.isFinite(capData.person_count)
              ? capData.person_count
              : undefined,
        };

        upsertMediaAiFieldsForAnalysis({
          mediaId,
          caption: captionForDb,
        });

        rebuildMediaSearchDoc(mediaId);
        updateAnalysisStatusCloud(mediaId, "success");
        logger.info({
          message: "cloudCaptionWorker.completed",
          details: { mediaId, userId },
        });
      } else {
        const errorCode = captionModule?.error?.code || "CLOUD_CAPTION_FAILED";
        updateAnalysisStatusCloud(mediaId, "failed");
        logger.warn({
          message: "cloudCaptionWorker.caption_failed",
          details: { mediaId, userId, status: capStatus, errorCode },
        });
        throw new Error(String(errorCode));
      }
    }
  } catch (error) {
    updateAnalysisStatusCloud(mediaId, "failed");
    logger.error({
      message: "cloudCaptionWorker.error",
      details: { mediaId, userId, error: error?.message },
    });
    throw error;
  }
}

const worker = new Worker(QUEUE_NAME, processJob, {
  connection,
});

module.exports = {
  worker,
};

