/*
 * @Description: 媒体智能分析状态与汇总字段（落在 media 表）
 */

const { db } = require("../services/database");

function markMediaAnalysisRunning(mediaId, analysisVersion) {
  db.prepare(
    `
    UPDATE media SET
      analysis_status = 'running',
      analysis_version = ?,
      last_error = NULL,
      last_error_at = NULL
    WHERE id = ?
  `,
  ).run(analysisVersion, mediaId);
}

function markMediaAnalysisFailed(mediaId, analysisVersion, error) {
  if (!mediaId) {
    return;
  }
  const code = (error && (error.code || error.message || "") || "UNKNOWN_ERROR").slice(0, 255);
  const now = Date.now();
  db.prepare(
    `
    UPDATE media SET
      analysis_status = 'failed',
      analysis_version = ?,
      last_error = ?,
      last_error_at = ?
    WHERE id = ?
  `,
  ).run(analysisVersion, code, now, mediaId);
}

function finalizeMediaAnalysis({
  mediaId,
  analysisVersion,
  faceData = {},
  cleanupData = {},
  descriptionData = {},
}) {
  const faceCount = faceData.faceCount ?? null;
  const personCount = faceData.personCount ?? null;
  const primaryFaceQuality = faceData.primaryFaceQuality ?? null;
  const primaryExpression = faceData.primaryExpression ?? null;
  const primaryExpressionConfidence = faceData.primaryExpressionConfidence ?? null;
  const rawExprTags = faceData.expressionTagsText;
  const expressionTagsText =
    rawExprTags != null && String(rawExprTags).trim() !== "" ? String(rawExprTags).trim() : null;
  const rawAgeTags = faceData.ageTagsText;
  const ageTagsText =
    rawAgeTags != null && String(rawAgeTags).trim() !== "" ? String(rawAgeTags).trim() : null;
  const rawGenderTags = faceData.genderTagsText;
  const genderTagsText =
    rawGenderTags != null && String(rawGenderTags).trim() !== "" ? String(rawGenderTags).trim() : null;
  const aestheticScore = cleanupData.aestheticScore ?? null;
  const sharpnessScore = cleanupData.sharpnessScore ?? null;
  const phash = cleanupData.phash ?? null;
  const dhash = cleanupData.dhash ?? null;

  db.prepare(
    `
    UPDATE media SET
      analysis_status = 'done',
      analysis_version = ?,
      analyzed_at = ?,
      phash = COALESCE(?, phash),
      dhash = COALESCE(?, dhash),
      face_count = COALESCE(?, face_count),
      person_count = COALESCE(?, person_count),
      primary_face_quality = COALESCE(?, primary_face_quality),
      primary_expression = COALESCE(?, primary_expression),
      primary_expression_confidence = COALESCE(?, primary_expression_confidence),
      expression_tags = COALESCE(?, expression_tags),
      age_tags = COALESCE(?, age_tags),
      gender_tags = COALESCE(?, gender_tags),
      aesthetic_score = COALESCE(?, aesthetic_score),
      sharpness_score = COALESCE(?, sharpness_score),
      last_error = NULL,
      last_error_at = NULL
    WHERE id = ?
  `,
  ).run(
    analysisVersion,
    Date.now(),
    phash,
    dhash,
    faceCount,
    personCount,
    primaryFaceQuality,
    primaryExpression,
    primaryExpressionConfidence,
    expressionTagsText,
    ageTagsText,
    genderTagsText,
    aestheticScore,
    sharpnessScore,
    mediaId,
  );
}

module.exports = {
  markMediaAnalysisRunning,
  markMediaAnalysisFailed,
  finalizeMediaAnalysis,
};
