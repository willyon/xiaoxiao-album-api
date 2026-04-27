/*
 * @Description: 媒体智能分析结果与汇总字段（落在 media 表）
 */
/**
 * 媒体分析汇总模型：负责主链路最终汇总 UPDATE（状态、人脸统计、清理质量与 caption 文本字段）。
 */
const { db } = require("../../db");
const { normalizeTextArray } = require("./mediaLocationSql");

/**
 * 主链路一次 UPDATE：primary 成功态 + 云阶段状态 + 人脸/质量汇总 + caption 文本字段。
 * face_count / person_count 仅来自 faceData（适配器内已用云 caption 覆盖 person 统计时与旧行为一致）。
 * caption 不传 faceCount/personCount，避免与 faceData 双写。
 * @param {string[]} assignments SQL 赋值片段列表
 * @param {any[]} params SQL 参数列表
 * @param {{description?:string,keywords?:Array<string>,subjectTags?:Array<string>,actionTags?:Array<string>,sceneTags?:Array<string>,ocr?:string}|null} caption caption 对象
 * @returns {void}
 */
function appendCaptionAiTextAssignments(assignments, params, caption) {
  if (caption == null) return;
  if (caption.description !== undefined) {
    assignments.push("ai_description = ?");
    params.push(caption.description);
  }
  if (caption.keywords !== undefined) {
    assignments.push("ai_keywords_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.keywords)));
  }
  if (caption.subjectTags !== undefined) {
    assignments.push("ai_subject_tags_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.subjectTags)));
  }
  if (caption.actionTags !== undefined) {
    assignments.push("ai_action_tags_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.actionTags)));
  }
  if (caption.sceneTags !== undefined) {
    assignments.push("ai_scene_tags_json = ?");
    params.push(JSON.stringify(normalizeTextArray(caption.sceneTags)));
  }
  if (caption.ocr !== undefined) {
    assignments.push("ai_ocr = ?");
    params.push(caption.ocr);
  }
}

/**
 * 写入媒体分析主链路最终汇总字段。
 * @param {{
 *   mediaId:number,
 *   analysisStatusCloud:"success"|"failed"|"skipped",
 *   caption?:{description?:string,keywords?:Array<string>,subjectTags?:Array<string>,actionTags?:Array<string>,sceneTags?:Array<string>,ocr?:string}|null,
 *   faceData?:{faceCount?:number,personCount?:number,preferredFaceQuality?:number,expressionTagsText?:string,ageTagsText?:string,genderTagsText?:string},
 *   cleanupData?:{sharpnessScore?:number,phash?:string,dhash?:string}
 * }} params 汇总参数
 * @returns {void}
 */
function finalizeMediaAnalysis({
  mediaId,
  analysisStatusCloud,
  caption = null,
  faceData = {},
  cleanupData = {},
}) {
  if (!mediaId) return;
  const allowedCloud = new Set(["success", "failed", "skipped"]);
  if (!allowedCloud.has(analysisStatusCloud)) {
    throw new Error(`finalizeMediaAnalysis: invalid analysisStatusCloud: ${analysisStatusCloud}`);
  }

  const faceCount = faceData.faceCount ?? null;
  const personCount = faceData.personCount ?? null;
  const preferredFaceQuality = faceData.preferredFaceQuality ?? null;
  const rawExprTags = faceData.expressionTagsText;
  const expressionTagsText =
    rawExprTags != null && String(rawExprTags).trim() !== "" ? String(rawExprTags).trim() : null;
  const rawAgeTags = faceData.ageTagsText;
  const ageTagsText =
    rawAgeTags != null && String(rawAgeTags).trim() !== "" ? String(rawAgeTags).trim() : null;
  const rawGenderTags = faceData.genderTagsText;
  const genderTagsText =
    rawGenderTags != null && String(rawGenderTags).trim() !== "" ? String(rawGenderTags).trim() : null;
  const sharpnessScore = cleanupData.sharpnessScore ?? null;
  const phash = cleanupData.phash ?? null;
  const dhash = cleanupData.dhash ?? null;

  const assignments = [
    "analysis_status_primary = 'success'",
    "analysis_status_cloud = ?",
    "phash = COALESCE(?, phash)",
    "dhash = COALESCE(?, dhash)",
    "face_count = COALESCE(?, face_count)",
    "person_count = COALESCE(?, person_count)",
    "preferred_face_quality = COALESCE(?, preferred_face_quality)",
    "expression_tags = COALESCE(?, expression_tags)",
    "age_tags = COALESCE(?, age_tags)",
    "gender_tags = COALESCE(?, gender_tags)",
    "sharpness_score = COALESCE(?, sharpness_score)",
  ];
  const params = [
    analysisStatusCloud,
    phash,
    dhash,
    faceCount,
    personCount,
    preferredFaceQuality,
    expressionTagsText,
    ageTagsText,
    genderTagsText,
    sharpnessScore,
  ];
  appendCaptionAiTextAssignments(assignments, params, caption);
  params.push(mediaId);

  db.prepare(`UPDATE media SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

module.exports = {
  finalizeMediaAnalysis,
};
