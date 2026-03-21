/*
 * @Description: media_analysis 表相关操作（状态与汇总更新）
 */

const { db } = require("../services/database");

function markMediaAnalysisRunning(mediaId, analysisVersion) {
  db.prepare(
    `
    INSERT INTO media_analysis (media_id, analysis_status, analysis_version, analyzed_at, last_error, last_error_at)
    VALUES (?, 'running', ?, NULL, NULL, NULL)
    ON CONFLICT(media_id) DO UPDATE SET
      analysis_status = 'running',
      analysis_version = excluded.analysis_version,
      last_error = NULL,
      last_error_at = NULL
  `,
  ).run(mediaId, analysisVersion);
}

function markMediaAnalysisFailed(mediaId, analysisVersion, error) {
  if (!mediaId) {
    return;
  }
  const code = (error && (error.code || error.message || "") || "UNKNOWN_ERROR").slice(0, 255);
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO media_analysis (media_id, analysis_status, analysis_version, analyzed_at, last_error, last_error_at)
    VALUES (?, 'failed', ?, NULL, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      analysis_status = 'failed',
      analysis_version = excluded.analysis_version,
      last_error = excluded.last_error,
      last_error_at = excluded.last_error_at
  `,
  ).run(mediaId, analysisVersion, code, now);
}

function finalizeMediaAnalysis({
  mediaId,
  analysisVersion,
  faceData = {},
  cleanupData = {},
  descriptionData = {},
  ocrData = {},
}) {
  const faceCount = faceData.faceCount ?? null;
  const personCount = faceData.personCount ?? null;
  const primaryFaceQuality = faceData.primaryFaceQuality ?? null;
  const primaryExpression = faceData.primaryExpression ?? null;
  const primaryExpressionConfidence = faceData.primaryExpressionConfidence ?? null;
  const aestheticScore = cleanupData.aestheticScore ?? null;
  const sharpnessScore = cleanupData.sharpnessScore ?? null;
  const hasDescription = typeof descriptionData.description === "string" ? 1 : null;
  /** blocks 未传：本轮未带回 OCR 结果，不更新 has_ocr；[]：明确无字，写 0 */
  const hasOcr = !Array.isArray(ocrData.blocks) ? null : ocrData.blocks.length > 0 ? 1 : 0;

  db.prepare(
    `
    INSERT INTO media_analysis (
      media_id, analysis_status, analysis_version, analyzed_at,
      face_count, person_count, primary_face_quality, primary_expression, primary_expression_confidence,
      aesthetic_score, sharpness_score, has_description, has_ocr, last_error, last_error_at
    )
    VALUES (?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(media_id) DO UPDATE SET
      analysis_status = 'done',
      analysis_version = excluded.analysis_version,
      analyzed_at = excluded.analyzed_at,
      face_count = COALESCE(excluded.face_count, media_analysis.face_count),
      person_count = COALESCE(excluded.person_count, media_analysis.person_count),
      primary_face_quality = COALESCE(excluded.primary_face_quality, media_analysis.primary_face_quality),
      primary_expression = COALESCE(excluded.primary_expression, media_analysis.primary_expression),
      primary_expression_confidence = COALESCE(excluded.primary_expression_confidence, media_analysis.primary_expression_confidence),
      aesthetic_score = COALESCE(excluded.aesthetic_score, media_analysis.aesthetic_score),
      sharpness_score = COALESCE(excluded.sharpness_score, media_analysis.sharpness_score),
      has_description = COALESCE(excluded.has_description, media_analysis.has_description),
      has_ocr = COALESCE(excluded.has_ocr, media_analysis.has_ocr),
      last_error = NULL,
      last_error_at = NULL
  `,
  ).run(
    mediaId,
    analysisVersion,
    Date.now(),
    faceCount,
    personCount,
    primaryFaceQuality,
    primaryExpression,
    primaryExpressionConfidence,
    aestheticScore,
    sharpnessScore,
    hasDescription,
    hasOcr,
  );
}

module.exports = {
  markMediaAnalysisRunning,
  markMediaAnalysisFailed,
  finalizeMediaAnalysis,
};

