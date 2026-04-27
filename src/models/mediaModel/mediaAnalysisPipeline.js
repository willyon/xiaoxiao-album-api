/**
 * 媒体分析管线写模型：负责 primary/cloud/map 状态写入、AI 字段回填与人脸 embedding 入库。
 */
const { db } = require("../../db");
const { normalizeTextArray } = require("./mediaLocationSql");

/**
 * 更新本地分析阶段终态。
 * @param {number} mediaId 媒体 ID
 * @param {"success"|"failed"} status 状态
 * @returns {{affectedRows:number}} 更新结果
 */
function updateAnalysisStatusPrimary(mediaId, status) {
  if (!mediaId) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed"]);
  if (!allowed.has(status)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET analysis_status_primary = ?
      WHERE id = ?
    `,
    )
    .run(status, mediaId);
  return { affectedRows: result.changes };
}

/**
 * 更新云分析阶段终态。
 * @param {number} mediaId 媒体 ID
 * @param {"success"|"failed"|"skipped"} status 状态
 * @returns {{affectedRows:number}} 更新结果
 */
function updateAnalysisStatusCloud(mediaId, status) {
  if (!mediaId) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed", "skipped"]);
  if (!allowed.has(status)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET analysis_status_cloud = ?
      WHERE id = ?
    `,
    )
    .run(status, mediaId);
  return { affectedRows: result.changes };
}

/**
 * 更新地图逆地理阶段终态。
 * @param {number} mediaId 媒体 ID
 * @param {"success"|"failed"|"skipped"} status 状态
 * @returns {{affectedRows:number}} 更新结果
 */
function updateMapRegeoStatus(mediaId, status) {
  if (!mediaId) return { affectedRows: 0 };
  const allowed = new Set(["success", "failed", "skipped"]);
  if (!allowed.has(status)) return { affectedRows: 0 };
  const result = db
    .prepare(
      `
      UPDATE media
      SET map_regeo_status = ?
      WHERE id = ?
    `,
    )
    .run(status, mediaId);
  return { affectedRows: result.changes };
}

/**
 * 按传入字段回填 AI 文本与人脸人数统计字段。
 * @param {{
 *   mediaId:number|string,
 *   caption:{
 *     description?:string,
 *     keywords?:Array<string>,
 *     subjectTags?:Array<string>,
 *     actionTags?:Array<string>,
 *     sceneTags?:Array<string>,
 *     ocr?:string,
 *     faceCount?:number|null,
 *     personCount?:number|null
 *   }|null
 * }} params 回填参数
 * @returns {void}
 */
function upsertMediaAiFieldsForAnalysis({ mediaId, caption }) {
  if (caption == null) return;

  const assignments = [];
  const params = [];

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
  if (caption.faceCount !== undefined && caption.faceCount !== null) {
    const fc = typeof caption.faceCount === "number" && Number.isFinite(caption.faceCount) ? Math.max(0, Math.floor(caption.faceCount)) : null;
    if (fc !== null) {
      assignments.push("face_count = ?");
      params.push(fc);
    }
  }
  if (caption.personCount !== undefined && caption.personCount !== null) {
    const pc = typeof caption.personCount === "number" && Number.isFinite(caption.personCount) ? Math.max(0, Math.floor(caption.personCount)) : null;
    if (pc !== null) {
      assignments.push("person_count = ?");
      params.push(pc);
    }
  }

  if (assignments.length === 0) return;
  params.push(mediaId);
  db.prepare(`UPDATE media SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

/**
 * 先清后写指定媒体的人脸 embedding 列表。
 * @param {number|string} mediaId 媒体 ID
 * @param {Array<{face_index:number,embedding:Array<number>,age?:number,gender?:string,expression?:string,confidence?:number,quality_score?:number,bbox?:Array<number>,pose?:object}>} faceData 人脸数组
 * @param {{sourceType?:"image"|"video"}} [options] 写入来源类型
 * @returns {Promise<{affectedRows:number}>} 写入结果
 */
async function insertFaceEmbeddings(mediaId, faceData, options = {}) {
  try {
    const sourceType = options.sourceType === "video" ? "video" : "image";
    const normalizedFaces = Array.isArray(faceData) ? faceData : [];
    const deleteStmt = db.prepare(`DELETE FROM media_face_embeddings WHERE media_id = ? AND source_type = ?`);
    const insertStmt = db.prepare(`
      INSERT INTO media_face_embeddings (
        media_id, source_type, face_index, embedding, age, gender, expression, confidence, quality_score, bbox, pose
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const runInTransaction = db.transaction((targetMediaId, targetSourceType, faces) => {
      deleteStmt.run(targetMediaId, targetSourceType);

      if (faces.length === 0) {
        return { affectedRows: 0 };
      }

      let totalAffected = 0;
      for (const face of faces) {
        const embeddingBuffer = Buffer.from(JSON.stringify(face.embedding));
        const result = insertStmt.run(
          targetMediaId,
          targetSourceType,
          face.face_index,
          embeddingBuffer,
          face.age || null,
          face.gender || null,
          face.expression || null,
          face.confidence || null,
          face.quality_score || null,
          JSON.stringify(face.bbox || []),
          JSON.stringify(face.pose || {}),
        );
        totalAffected += result.changes;
      }

      return { affectedRows: totalAffected };
    });

    return runInTransaction(mediaId, sourceType, normalizedFaces);
  } catch (error) {
    console.error("插入人脸特征向量失败:", error);
    throw error;
  }
}

module.exports = {
  updateAnalysisStatusPrimary,
  updateAnalysisStatusCloud,
  updateMapRegeoStatus,
  upsertMediaAiFieldsForAnalysis,
  insertFaceEmbeddings,
};
