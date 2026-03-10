/*
 * @Description: 智能清理队列任务处理器
 */
const logger = require("../utils/logger");
const storageService = require("../services/storageService");
const { runCleanupAnalysisCore } = require("../services/cleanupAnalysisService");

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
    const buffer = await _loadImageBuffer({ hintHighRes, hintOriginal });
    if (!buffer) {
      logger.warn({
        message: "无法读取图片数据，跳过",
        details: { imageId, userId },
      });
      return { userId, imageId, processed: false, reason: "load_buffer_failed" };
    }

    const result = await runCleanupAnalysisCore({ imageId, userId, buffer });
    if (!result.ok) {
      logger.warn({
        message: "cleanup.core.failed",
        details: { imageId, userId, errorCode: result.errorCode },
      });
      return { userId, imageId, processed: false, reason: result.errorCode };
    }

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

module.exports = {
  processCleanupScan,
};
