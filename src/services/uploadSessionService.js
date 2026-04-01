/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理服务
 */
const { v4: uuidv4 } = require("uuid");
const { getRedisClient } = require("./redisClient");
const logger = require("../utils/logger");
const { normalizeProgressData, hasAnyProgressData } = require("../utils/uploadProgressSnapshot");

// 获取 Redis 客户端实例
const redisClient = getRedisClient();

/**
 * 创建上传会话
 * @param {string} userId - 用户ID
 * @returns {Object} 会话对象
 */
async function createSession(userId) {
  // 生成会话ID
  const sessionId = uuidv4();

  // 在Redis中创建会话
  await redisClient.hset(`upload:session:${sessionId}`, {
    uploadedCount: 0,
    ingestDoneCount: 0,
    ingestErrorCount: 0,
    duplicateCount: 0, // Controller层检测的重复（不加入队列）
    workerSkippedCount: 0, // Worker层检测的重复（已加入队列但跳过）
    existingFiles: 0,
    aiEligibleCount: 0,
    aiDoneCount: 0,
    aiErrorCount: 0,
  });

  // 设置用户的最新会话ID（覆盖之前的会话）
  await redisClient.set(`user:latest:session:${userId}`, sessionId);

  // 设置过期时间（1天）
  await redisClient.expire(`upload:session:${sessionId}`, 1 * 24 * 3600);
  await redisClient.expire(`user:latest:session:${userId}`, 1 * 24 * 3600);

  return {
    sessionId,
    uploadedCount: 0,
    ingestDoneCount: 0,
    ingestErrorCount: 0,
    duplicateCount: 0,
    workerSkippedCount: 0,
    existingFiles: 0,
    aiEligibleCount: 0,
    aiDoneCount: 0,
    aiErrorCount: 0,
    phase: "uploading",
    completed: false,
    timestamp: Date.now(),
  };
}

/**
 * 获取用户的活跃会话
 * @param {string} userId - 用户ID
 * @returns {Object|null} 会话对象，如果没有活跃会话则返回null
 */
async function getActiveSession(userId) {
  // 获取用户的最新会话ID
  const activeSessionId = await redisClient.get(`user:latest:session:${userId}`);

  if (!activeSessionId) {
    return null;
  }

  try {
    // 直接获取最新会话的详细信息
    const redisData = await redisClient.hgetall(`upload:session:${activeSessionId}`);

    if (redisData && Object.keys(redisData).length > 0) {
      const snapshot = normalizeProgressData(activeSessionId, redisData);
      const isActive = hasAnyProgressData(snapshot) && !snapshot.completed;

      if (!isActive) {
        return null;
      }

      return snapshot;
    }

    return null;
  } catch (redisError) {
    logger.warn({
      message: "Redis数据获取失败",
      details: { sessionId: activeSessionId, error: redisError.message },
    });
    return null;
  }
}

async function getCurrentProgressSnapshot(userId) {
  const activeSessionId = await redisClient.get(`user:latest:session:${userId}`);
  if (!activeSessionId) {
    return { active: false, session: null };
  }

  const redisData = await redisClient.hgetall(`upload:session:${activeSessionId}`);
  if (!redisData || Object.keys(redisData).length === 0) {
    return { active: false, session: null };
  }

  const snapshot = normalizeProgressData(activeSessionId, redisData);
  const active = hasAnyProgressData(snapshot) && !snapshot.completed;

  if (!active) {
    return { active: false, session: null };
  }

  return { active: true, session: snapshot };
}

async function addMediaToSession({ sessionId, mediaId }) {
  if (!sessionId || !mediaId) return;
  const sessionMediaSetKey = `upload:session:${sessionId}:media_ids`;
  await redisClient.sadd(sessionMediaSetKey, String(mediaId));
  await redisClient.expire(sessionMediaSetKey, 1 * 24 * 3600);
}

async function addAiFailureToSession({ sessionId, mediaId, fileName, errorCode, errorMessage, retryable = true }) {
  if (!sessionId || !mediaId) return;

  const failuresKey = `upload:session:${sessionId}:failures:ai`;
  const failurePayload = {
    mediaId: String(mediaId),
    fileName: fileName || "",
    status: "failed",
    errorCode: errorCode || "AI_ANALYSIS_FAILED",
    errorMessage: errorMessage || "AI analysis failed",
    retryable: Boolean(retryable),
    failedAt: new Date().toISOString(),
  };

  await redisClient.lpush(failuresKey, JSON.stringify(failurePayload));
  await redisClient.ltrim(failuresKey, 0, 199);
  await redisClient.expire(failuresKey, 1 * 24 * 3600);
}

async function getAiFailuresBySessionId(sessionId) {
  if (!sessionId) return [];
  const failuresKey = `upload:session:${sessionId}:failures:ai`;
  const rows = await redisClient.lrange(failuresKey, 0, 199);

  return rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function clearAiFailuresByMediaIds(sessionId, mediaIds = []) {
  if (!sessionId || !Array.isArray(mediaIds) || mediaIds.length === 0) return;

  const failuresKey = `upload:session:${sessionId}:failures:ai`;
  const rows = await redisClient.lrange(failuresKey, 0, 199);
  if (!rows || rows.length === 0) return;

  const targetSet = new Set(mediaIds.map((id) => String(id)));
  const remainedRows = rows.filter((row) => {
    try {
      const item = JSON.parse(row);
      return !targetSet.has(String(item.mediaId));
    } catch (_error) {
      return true;
    }
  });

  await redisClient.del(failuresKey);
  if (remainedRows.length > 0) {
    await redisClient.rpush(failuresKey, ...remainedRows);
    await redisClient.expire(failuresKey, 1 * 24 * 3600);
  }
}

async function resetAiErrorMarkersForRetry(sessionId, mediaIds = []) {
  if (!sessionId || !Array.isArray(mediaIds) || mediaIds.length === 0) return;
  const markerKey = `upload:session:${sessionId}:counter_marker:aiErrorCount`;
  await redisClient.srem(markerKey, ...mediaIds.map((id) => String(id)));
}

async function decrementAiErrorCountForRetry(sessionId, count = 0) {
  if (!sessionId || !count || count <= 0) return;
  await redisClient.hincrby(`upload:session:${sessionId}`, "aiErrorCount", -count);
}

module.exports = {
  createSession,
  getActiveSession,
  getCurrentProgressSnapshot,
  addMediaToSession,
  addAiFailureToSession,
  getAiFailuresBySessionId,
  clearAiFailuresByMediaIds,
  resetAiErrorMarkersForRetry,
  decrementAiErrorCountForRetry,
};
