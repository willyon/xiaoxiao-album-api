/**
 * 上传会话进度：Redis Hash `upload:session:{sessionId}` 的 9 个计数字段，以及本文件中的归一化与「是否完成」推导。
 *
 * 写入入口：`mediaProcessingProgressService.updateProgress` / `updateProgressOnce`（AI/Meta 等多处按会话递增）。
 * 幂等类计数使用 Redis Set `upload:session:{sessionId}:counter_marker:{status}`，dedupeKey 多为 imageHash 或 mediaId。
 *
 * ── 九个字段（均存于 Hash，值为非负整数）──
 *
 * uploadedCount — 会计入「应走入库/Meta 流水线」的文件数。秒传、控制器层判重通常不增加此项，它是媒体阶段分母。
 *
 * ingestDoneCount — Meta/入库流水线成功结束的次数（每媒体成功 +1）。
 *
 * ingestErrorCount — Meta 耗尽重试后的最终失败次数；同会话同图只计一次（按 hash 幂等）。
 *
 * duplicateCount — 控制器/API 层判为重复（未入队或在该层短路），与前端本地重复统计并列。
 *
 * workerSkippedCount — 任务已入队，但 Worker 发现用户 hash 集合已存在而跳过；在进度上等价于「媒体侧已处理完毕、无需再跑 Meta」。
 *
 * existingFiles — 秒传：库内已有有效记录（如 checkFileExists），不走完整流水线。
 *
 * aiEligibleCount — 实际成功入队 AI 分析的媒体数（按 mediaId 幂等）。AI 环分母必须用此项，不能简单用 ingestDoneCount（例如入队失败时二者可能不一致）。
 *
 * aiDoneCount — 主链路 AI 分析成功结束次数（按 mediaId 幂等）。
 *
 * aiErrorCount — 主链路 AI 判定最终失败次数（按 mediaId 幂等）。
 *
 * ── 派生（不存 Redis）──
 *
 * normalizeProgressData 会附加 completed、phase、timestamp。媒体阶段完成条件：uploadedCount===0 或
 * ingestDoneCount + ingestErrorCount + workerSkippedCount >= uploadedCount。
 * AI 阶段完成条件：aiEligibleCount===0 或 aiDoneCount + aiErrorCount >= aiEligibleCount。
 * 二者同时满足则 completed===true。duplicateCount、existingFiles 不参与媒体完成不等式，用于总文件数与「未走流水线」提示。
 */

function toInt(value) {
  return Number.parseInt(value, 10) || 0
}

function hasMediaSignal(progressData) {
  const { uploadedCount, ingestDoneCount, ingestErrorCount, duplicateCount, workerSkippedCount, existingFiles } = progressData

  return uploadedCount + ingestDoneCount + ingestErrorCount + duplicateCount + workerSkippedCount + existingFiles > 0
}

function computeMediaStageDone(progressData) {
  const { uploadedCount, ingestDoneCount, ingestErrorCount, workerSkippedCount } = progressData
  return uploadedCount === 0 || ingestDoneCount + ingestErrorCount + workerSkippedCount >= uploadedCount
}

function computeAiStageDone(progressData) {
  const { aiEligibleCount, aiDoneCount, aiErrorCount } = progressData
  return aiEligibleCount === 0 || aiDoneCount + aiErrorCount >= aiEligibleCount
}

function computeCompleted(progressData) {
  return computeMediaStageDone(progressData) && computeAiStageDone(progressData)
}

function computePhase(progressData) {
  if (progressData.completed) return 'completed'

  if (!hasMediaSignal(progressData) && progressData.aiEligibleCount === 0 && progressData.aiDoneCount === 0 && progressData.aiErrorCount === 0) {
    return 'uploading'
  }

  if (!computeMediaStageDone(progressData)) {
    return 'mediaProcessing'
  }

  if (!computeAiStageDone(progressData)) {
    return 'aiAnalyzing'
  }

  return 'completed'
}

function normalizeProgressData(sessionId, redisData = {}) {
  const ingestDoneCount = toInt(redisData.ingestDoneCount)
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
    aiErrorCount: toInt(redisData.aiErrorCount)
  }

  normalized.completed = computeCompleted(normalized)
  normalized.phase = computePhase(normalized)
  normalized.timestamp = Date.now()

  return normalized
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
  )
}

module.exports = {
  normalizeProgressData,
  computeMediaStageDone,
  computeAiStageDone,
  computeCompleted,
  hasAnyProgressData
}
