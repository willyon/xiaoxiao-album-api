const path = require("path");
const { cleanupQueue } = require("../queues/cleanupQueue");
const logger = require("../utils/logger");
const cleanupModel = require("../models/cleanupModel");

/**
 * 查找需要清理分析的图片（未分析的图片）
 * @param {number} userId - 用户ID（必填）
 * @returns {Array} 需要入队的图片列表
 */
function findImagesNeedingCleanup({ userId }) {
  if (!userId) {
    throw new Error("userId is required");
  }

  // 从 model 层直接获取未分析的图片（数据库层面过滤，性能更好）
  // 注意：已分析但未分组的图片（不在 cleanup_group_members 中）是正常的（可能是唯一图片），
  // 不需要再次入队分析，分组逻辑会通过去抖机制自动触发
  return cleanupModel.selectUnanalyzedImagesByUser(userId);
}

async function retryFailedCleanupJobs() {
  try {
    const failedJobs = await cleanupQueue.getFailed(0, 1000);
    if (!failedJobs.length) {
      return { hadFailed: false, retriedCount: 0 };
    }

    let retriedCount = 0;
    for (const job of failedJobs) {
      try {
        await job.retry();
        retriedCount += 1;
      } catch (error) {
        logger.warn({
          message: "重试 cleanup 失败任务时出错",
          details: { jobId: job.id, error: error.message },
        });
      }
    }

    return { hadFailed: true, retriedCount };
  } catch (error) {
    logger.warn({
      message: "获取 cleanup 失败任务列表时出错",
      details: { error: error.message },
    });
    return { hadFailed: false, retriedCount: 0 };
  }
}

async function enqueueCleanupJobs(records = []) {
  let successCount = 0;
  let skippedCount = 0;
  let failCount = 0;
  const errors = [];

  for (const record of records) {
    const jobId = `cleanup:${record.user_id}:${record.id}`;
    try {
      const job = await cleanupQueue.add(
        cleanupQueue.name,
        {
          userId: record.user_id,
          imageId: record.id,
          highResStorageKey: record.high_res_storage_key,
          originalStorageKey: record.original_storage_key,
        },
        { jobId },
      );

      if (job) {
        successCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      failCount += 1;
      errors.push({ imageId: record.id, userId: record.user_id, error: error.message });
    }
  }

  return { successCount, skippedCount, failCount, errors };
}

async function enqueueCleanupForUser(userId) {
  const records = findImagesNeedingCleanup({ userId });
  if (!records.length) {
    return {
      totalCandidates: 0,
      successCount: 0,
      skippedCount: 0,
      failCount: 0,
      errors: [],
    };
  }

  const enqueueResult = await enqueueCleanupJobs(records);
  return {
    totalCandidates: records.length,
    ...enqueueResult,
  };
}

module.exports = {
  findImagesNeedingCleanup,
  retryFailedCleanupJobs,
  enqueueCleanupJobs,
  enqueueCleanupForUser,
};
