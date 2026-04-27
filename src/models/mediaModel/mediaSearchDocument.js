/**
 * 媒体搜索文档模型：负责 media_search 文档重建、FTS 同步与 terms 行维护。
 */
const { db } = require("../../db");
const { buildMediaSearchTermRows, buildSearchTermsFromFields } = require("../../utils/searchTermUtils");
const { clearSearchRankCache } = require("../../utils/searchRankCacheStore");
const { deleteMediaEmbeddingBySourceType, MEDIA_EMBEDDING_SOURCE_TYPES } = require("./mediaEmbeddingModel");
const { normalizeTextArray } = require("./mediaLocationSql");

/**
 * 解析 JSON 文本数组并归一化为字符串数组。
 * @param {string|null|undefined} input - JSON 字符串。
 * @returns {string[]} 归一化数组。
 */
function parseJsonTextArray(input) {
  if (!input || typeof input !== "string") return [];
  try {
    return normalizeTextArray(JSON.parse(input));
  } catch {
    return [];
  }
}

/**
 * 收集单条媒体用于搜索文档重建的字段快照。
 * @param {number|string} mediaId 媒体 ID
 * @returns {{media:object,fields:{description:string|null,keywords:string|null,subject_tags:string|null,action_tags:string|null,scene_tags:string|null,ocr:string|null}}|null} 文档快照
 */
function collectMediaSearchDocument(mediaId) {
  const media = db
    .prepare(
      `
      SELECT id, user_id, deleted_at,
             ai_description, ai_keywords_json, ai_subject_tags_json, ai_action_tags_json, ai_scene_tags_json,
             ai_ocr
      FROM media WHERE id = ?
    `,
    )
    .get(mediaId);
  if (!media) return null;

  const descriptionText = media.ai_description ? String(media.ai_description) : null;
  const keywordTokens = new Set(parseJsonTextArray(media.ai_keywords_json));
  const subjectTagTokens = new Set(parseJsonTextArray(media.ai_subject_tags_json));
  const actionTagTokens = new Set(parseJsonTextArray(media.ai_action_tags_json));
  const sceneTagTokens = new Set(parseJsonTextArray(media.ai_scene_tags_json));

  const keywordsText = keywordTokens.size > 0 ? Array.from(keywordTokens).join(" ") : null;
  const subjectTagsText = subjectTagTokens.size > 0 ? Array.from(subjectTagTokens).join(" ") : null;
  const actionTagsText = actionTagTokens.size > 0 ? Array.from(actionTagTokens).join(" ") : null;
  const sceneTagsText = sceneTagTokens.size > 0 ? Array.from(sceneTagTokens).join(" ") : null;
  const pickNonEmpty = (v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t !== "" ? t : null;
  };
  const ocrValue = pickNonEmpty(media.ai_ocr);

  return {
    media,
    fields: {
      description: descriptionText,
      keywords: keywordsText,
      subject_tags: subjectTagsText,
      action_tags: actionTagsText,
      scene_tags: sceneTagsText,
      ocr: ocrValue,
    },
  };
}

/**
 * 重建指定媒体的 media_search_terms 明细行。
 * @param {{mediaId:number,userId:number,fields:{description?:string|null,keywords?:string|null,subject_tags?:string|null,action_tags?:string|null,scene_tags?:string|null,ocr?:string|null},updatedAt:number}} params 构建参数
 * @returns {number} 写入条数
 */
function replaceMediaSearchTermsForDocument({ mediaId, userId, fields, updatedAt }) {
  const rows = buildMediaSearchTermRows({ mediaId, userId, fields, updatedAt });
  const insertStmt = db.prepare(`
    INSERT INTO media_search_terms (
      media_id, user_id, field_type, term, term_len, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const runInTransaction = db.transaction((targetMediaId, targetRows) => {
    db.prepare("DELETE FROM media_search_terms WHERE media_id = ?").run(targetMediaId);
    if (targetRows.length === 0) return 0;
    for (const row of targetRows) {
      insertStmt.run(row.mediaId, row.userId, row.fieldType, row.term, row.termLen, row.updatedAt);
    }
    return targetRows.length;
  });

  return runInTransaction(mediaId, rows);
}

/**
 * 将 media_search 单行同步到 FTS 虚拟表。
 * @param {number|string} mediaId 媒体 ID
 * @returns {void}
 */
function syncMediaSearchFtsRow(mediaId) {
  const row = db
    .prepare(
      `
      SELECT media_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
             caption_search_terms
      FROM media_search WHERE media_id = ?
    `,
    )
    .get(mediaId);
  const insertStmt = db.prepare(
    `
    INSERT INTO media_search_fts(
      rowid, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
      caption_search_terms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  );
  const runInTransaction = db.transaction((targetMediaId, targetRow) => {
    db.prepare("DELETE FROM media_search_fts WHERE rowid = ?").run(targetMediaId);
    if (!targetRow) return;
    insertStmt.run(
      targetRow.media_id,
      targetRow.description_text,
      targetRow.keywords_text,
      targetRow.subject_tags_text,
      targetRow.action_tags_text,
      targetRow.scene_tags_text,
      targetRow.caption_search_terms,
    );
  });
  runInTransaction(mediaId, row);
}

/**
 * 重建媒体搜索文档主入口：维护 media_search、media_search_terms、media_search_fts 及相关缓存。
 * @param {number|string} mediaId 媒体 ID
 * @returns {{affectedRows:number,termRows:number}} 执行结果
 */
function rebuildMediaSearchDoc(mediaId) {
  const doc = collectMediaSearchDocument(mediaId);
  if (!doc) return { affectedRows: 0, termRows: 0 };
  const { media, fields } = doc;
  const updatedAt = Date.now();

  if (media.deleted_at != null) {
    db.prepare("DELETE FROM media_search_fts WHERE rowid = ?").run(mediaId);
    const deleted = db.prepare("DELETE FROM media_search WHERE media_id = ?").run(mediaId);
    db.prepare("DELETE FROM media_search_terms WHERE media_id = ?").run(mediaId);
    deleteMediaEmbeddingBySourceType({
      mediaId,
      sourceType: MEDIA_EMBEDDING_SOURCE_TYPES.VISUAL_TEXT,
    });
    clearSearchRankCache();
    return { affectedRows: deleted.changes, termRows: 0 };
  }

  const searchTermsText = buildSearchTermsFromFields(fields);
  const upsert = db.prepare(`
    INSERT INTO media_search (
      media_id, user_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
      ocr_text, caption_search_terms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      user_id = excluded.user_id,
      description_text = excluded.description_text,
      keywords_text = excluded.keywords_text,
      subject_tags_text = excluded.subject_tags_text,
      action_tags_text = excluded.action_tags_text,
      scene_tags_text = excluded.scene_tags_text,
      ocr_text = excluded.ocr_text,
      caption_search_terms = excluded.caption_search_terms,
      updated_at = excluded.updated_at
  `);

  const result = upsert.run(
    media.id,
    media.user_id,
    fields.description,
    fields.keywords,
    fields.subject_tags,
    fields.action_tags,
    fields.scene_tags,
    fields.ocr,
    searchTermsText,
    updatedAt,
  );

  const { ocr: _ocr, ...fieldsWithoutOcrForTerms } = fields;
  const termRows = replaceMediaSearchTermsForDocument({
    mediaId: media.id,
    userId: media.user_id,
    fields: fieldsWithoutOcrForTerms,
    updatedAt,
  });

  syncMediaSearchFtsRow(media.id);
  clearSearchRankCache();
  return { affectedRows: result.changes, termRows };
}

module.exports = {
  rebuildMediaSearchDoc,
};
