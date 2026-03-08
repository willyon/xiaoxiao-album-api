function toInt(value) {
  return Number.parseInt(value, 10) || 0;
}

function hasMediaSignal(progressData) {
  const {
    uploadedCount,
    thumbDone,
    thumbErrors,
    highResDone,
    highResErrors,
    duplicateCount,
    workerSkippedCount,
    existingFiles,
  } = progressData;

  return uploadedCount + thumbDone + thumbErrors + highResDone + highResErrors + duplicateCount + workerSkippedCount + existingFiles > 0;
}

function computeMediaStageDone(progressData) {
  const { uploadedCount, highResDone, highResErrors, workerSkippedCount } = progressData;
  return uploadedCount === 0 || highResDone + highResErrors + workerSkippedCount >= uploadedCount;
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
  const normalized = {
    sessionId,
    uploadedCount: toInt(redisData.uploadedCount),
    thumbDone: toInt(redisData.thumbDone),
    highResDone: toInt(redisData.highResDone),
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
      progressData.highResDone +
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
