function toInt(value) {
  return Number.parseInt(value, 10) || 0;
}

function hasMediaSignal(progressData) {
  const {
    uploadedCount,
    ingestDoneCount,
    ingestErrorCount,
    duplicateCount,
    workerSkippedCount,
    existingFiles,
  } = progressData;

  return uploadedCount + ingestDoneCount + ingestErrorCount + duplicateCount + workerSkippedCount + existingFiles > 0;
}

function computeMediaStageDone(progressData) {
  const { uploadedCount, ingestDoneCount, ingestErrorCount, workerSkippedCount } = progressData;
  return uploadedCount === 0 || ingestDoneCount + ingestErrorCount + workerSkippedCount >= uploadedCount;
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
  const ingestDoneCount = toInt(redisData.ingestDoneCount);
  const normalized = {
    sessionId,
    uploadedCount: toInt(redisData.uploadedCount),
    ingestDoneCount,
    ingestErrorCount: toInt(redisData.ingestErrorCount),
    duplicateCount: toInt(redisData.duplicateCount),
    workerSkippedCount: toInt(redisData.workerSkippedCount),
    existingFiles: toInt(redisData.existingFiles),
    aiEligibleCount: toInt(redisData.aiEligibleCount),
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
      progressData.ingestDoneCount +
      progressData.ingestErrorCount +
      progressData.duplicateCount +
      progressData.workerSkippedCount +
      progressData.existingFiles +
      progressData.aiEligibleCount +
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
