function toInt(value) {
  return Number.parseInt(value, 10) || 0;
}

function hasMediaSignal(progressData) {
  const {
    uploadedCount,
    thumbDone,
    thumbErrors,
    mediaDone,
    highResErrors,
    duplicateCount,
    workerSkippedCount,
    existingFiles,
  } = progressData;

  return uploadedCount + thumbDone + thumbErrors + mediaDone + highResErrors + duplicateCount + workerSkippedCount + existingFiles > 0;
}

function computeMediaStageDone(progressData) {
  const { uploadedCount, mediaDone, highResErrors, workerSkippedCount } = progressData;
  return uploadedCount === 0 || mediaDone + highResErrors + workerSkippedCount >= uploadedCount;
}

function computeAiStageDone(progressData) {
  const { aiEligibleCount, aiDoneCount, aiErrorCount } = progressData;
  return aiEligibleCount === 0 || aiDoneCount + aiErrorCount >= aiEligibleCount;
}

function computeCompleted(progressData) {
  return computeMediaStageDone(progressData) && computeAiStageDone(progressData);
}

function computePhase(progressData) {
  if (progressData.completed) return "completed";

  if (!hasMediaSignal(progressData) && progressData.aiEligibleCount === 0 && progressData.aiDoneCount === 0 && progressData.aiErrorCount === 0) {
    return "uploading";
  }

  if (!computeMediaStageDone(progressData)) {
    return "mediaProcessing";
  }

  if (!computeAiStageDone(progressData)) {
    return "aiAnalyzing";
  }

  return "completed";
}

function normalizeProgressData(sessionId, redisData = {}) {
  // 兼容历史会话：若只有 highResDone，则回退使用该字段
  const mediaDone = toInt(redisData.mediaDone || redisData.highResDone);
  const normalized = {
    sessionId,
    uploadedCount: toInt(redisData.uploadedCount),
    thumbDone: toInt(redisData.thumbDone),
    mediaDone,
    // 保留旧字段，避免老版本前端/脚本读取失败
    highResDone: mediaDone,
    thumbErrors: toInt(redisData.thumbErrors),
    highResErrors: toInt(redisData.highResErrors),
    duplicateCount: toInt(redisData.duplicateCount),
    workerSkippedCount: toInt(redisData.workerSkippedCount),
    existingFiles: toInt(redisData.existingFiles),
    aiEligibleCount: toInt(redisData.aiEligibleCount),
    aiQueuedCount: toInt(redisData.aiQueuedCount),
    aiDoneCount: toInt(redisData.aiDoneCount),
    aiErrorCount: toInt(redisData.aiErrorCount),
  };

  normalized.completed = computeCompleted(normalized);
  normalized.phase = computePhase(normalized);
  normalized.timestamp = Date.now();

  return normalized;
}

function hasAnyProgressData(progressData) {
  return (
    progressData.uploadedCount +
      progressData.thumbDone +
      progressData.mediaDone +
      progressData.thumbErrors +
      progressData.highResErrors +
      progressData.duplicateCount +
      progressData.workerSkippedCount +
      progressData.existingFiles +
      progressData.aiEligibleCount +
      progressData.aiQueuedCount +
      progressData.aiDoneCount +
      progressData.aiErrorCount >
    0
  );
}

module.exports = {
  normalizeProgressData,
  computeMediaStageDone,
  computeAiStageDone,
  computeCompleted,
  hasAnyProgressData,
};
