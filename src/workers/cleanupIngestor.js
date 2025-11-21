/*
 * @Description: 智能清理队列任务处理器
 */
const axios = require("axios");
const logger = require("../utils/logger");
const cleanupModel = require("../models/cleanupModel");
const { upsertImageEmbedding, getImageEmbedding } = require("../models/imageEmbeddingModel");
const storageService = require("../services/storageService");
const { scheduleUserRebuild } = require("../services/cleanupGroupingScheduler");

const PYTHON_SERVICE_URL = process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

const { FormData, Blob } = globalThis;

async function processCleanupScan(job) {
  const { userId, imageId, highResStorageKey: hintHighRes, originalStorageKey: hintOriginal } = job.data || {};

  if (!imageId) {
    logger.warn({
      message: "cleanupIngestor 收到无效任务，缺少 imageId",
      details: { jobId: job.id, data: job.data },
    });
    return { status: "skipped", reason: "missing_image_id" };
  }

  try {
    // 先检查是否已有 embedding，如果有则传递给 Python 服务，跳过 SigLIP 计算
    const existingEmbedding = getImageEmbedding(imageId);

    const buffer = await _loadImageBuffer({ hintHighRes, hintOriginal });
    if (!buffer) {
      logger.warn({
        message: "无法读取图片数据，跳过",
        details: { imageId, userId },
      });
      return { userId, imageId, processed: false, reason: "load_buffer_failed" };
    }

    const analysis = await _requestCleanupAnalysis(buffer, `image-${imageId}`, existingEmbedding);

    // 记录从接收 Python 结果到数据库存储完成的时间
    const t0 = Date.now();

    // 直接存储清晰度分数，模糊图判断逻辑在分组服务中进行
    const round2 = (v) => (typeof v === "number" ? Number(v.toFixed(2)) : null);
    cleanupModel.updateImageCleanupMetrics(imageId, {
      imagePhash: analysis?.hashes?.phash ?? null,
      imageDhash: analysis?.hashes?.dhash ?? null,
      aestheticScore: round2(analysis.aesthetic_score ?? null),
      sharpnessScore: round2(analysis.sharpness_score ?? null),
    });

    const embeddingVec = Array.isArray(analysis?.embedding?.vector) ? analysis.embedding.vector : null;
    const embeddingModel = analysis?.embedding?.model || "siglip2";
    if (embeddingVec && embeddingVec.length) {
      try {
        upsertImageEmbedding({ imageId, vector: embeddingVec, modelId: embeddingModel });
      } catch (e) {
        logger.warn({ message: "保存图像向量失败，忽略不影响清理流程", details: { imageId, error: e.message } });
      }
    }

    // 改为去抖的用户级重建，避免每条都触发全量重建
    scheduleUserRebuild(userId);

    const dbWriteTime = Date.now() - t0;
    logger.info({
      message: "cleanup.db_write.completed",
      details: { imageId, userId, elapsed_ms: dbWriteTime },
    });

    logger.info({
      message: "智能清理任务完成",
      details: { userId, imageId },
    });

    return {
      userId,
      imageId,
      processed: true,
      summary: null,
    };
  } catch (error) {
    logger.error({
      message: "处理智能清理任务失败",
      details: { userId, imageId, error: error.message },
    });
    throw error;
  }
}

async function _loadImageBuffer({ hintHighRes, hintOriginal }) {
  const candidates = [hintHighRes, hintOriginal].filter(Boolean);
  for (const key of candidates) {
    // 先用当前适配器尝试
    const buffer = await storageService.storage.getFileBuffer(key);
    if (buffer) {
      return buffer;
    }
  }
  return null;
}

async function _requestCleanupAnalysis(buffer, fileName, existingEmbedding = null) {
  const formData = new FormData();
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type: "application/octet-stream" });
  formData.append("image", blob, `${fileName || "image"}.bin`);

  // 如果已有 embedding，通过 form data 传递，让 Python 服务跳过 SigLIP 计算
  if (existingEmbedding && existingEmbedding.vector && Array.isArray(existingEmbedding.vector)) {
    formData.append("skip_embedding", "true");
    // 将 embedding 向量作为 JSON 字符串传递
    formData.append("existing_embedding", JSON.stringify(existingEmbedding.vector));
    formData.append("embedding_model", existingEmbedding.modelId || "siglip2");
  }

  const response = await axios.post(`${PYTHON_SERVICE_URL}/analyze_cleanup`, formData, {
    timeout: Number(process.env.CLEANUP_ANALYSIS_TIMEOUT || 300000),
    maxBodyLength: Infinity,
    headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
  });

  return response.data || {};
}

module.exports = {
  processCleanupScan,
};
