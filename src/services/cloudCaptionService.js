const { cloudCaptionQueue } = require("../queues/cloudCaptionQueue");
const { getCloudCaptionProgressStats, selectPendingCloudCaptionBatch } = require("../models/mediaModel");

/**
 * 读取云 caption 分析进度（图片 + 视频统一统计）。
 */
function getCloudCaptionProgress() {
  return getCloudCaptionProgressStats();
}

/**
 * 为一批历史媒体创建云 caption 补跑任务，并将其 analysis_status_cloud 标记为 pending。
 * 返回本次入队的任务数量。
 */
async function enqueueCloudCaptionRebuildBatch(limitPerBatch = 500) {
  const rows = selectPendingCloudCaptionBatch(limitPerBatch);

  if (!rows || rows.length === 0) {
    return 0;
  }

  const jobs = rows.map((row) => ({
    name: `cloud-caption-${row.mediaId}`,
    data: {
      mediaId: row.mediaId,
      userId: row.userId,
      highResStorageKey: row.highResStorageKey,
      originalStorageKey: row.originalStorageKey,
      mediaType: row.mediaType || "image",
    },
  }));

  await cloudCaptionQueue.addBulk(jobs);

  return jobs.length;
}

module.exports = {
  getCloudCaptionProgress,
  enqueueCloudCaptionRebuildBatch,
};

