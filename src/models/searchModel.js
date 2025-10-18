/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 自然语言搜索功能和算法
 */

const { db } = require("../services/database");

/**
 * 全文搜索图片
 */
function searchImagesByText({ userId, query, limit = 50, offset = 0 }) {
  const sql = `
    SELECT 
      i.id,
      i.thumbnail_storage_key,
      i.high_res_storage_key,
      i.image_created_at,
      i.date_key,
      i.month_key,
      i.year_key,
      i.gps_location,
      i.storage_type,
      i.alt_text,
      i.ocr_text,
      i.keywords,
      i.scene_tags,
      i.object_tags,
      fts.rank
    FROM images_fts fts
    JOIN images i ON fts.rowid = i.id
    WHERE i.user_id = ? 
      AND images_fts MATCH ?
    ORDER BY fts.rank DESC, i.image_created_at DESC
    LIMIT ? OFFSET ?
  `;

  const stmt = db.prepare(sql);
  return stmt.all(userId, query, limit, offset);
}

/**
 * 获取搜索建议（基于现有标签）
 */
function getSearchSuggestions({ userId, prefix = "", limit = 10 }) {
  const suggestions = [];

  // 从各个标签字段获取建议
  const tagFields = ["scene_tags", "object_tags", "keywords"];

  tagFields.forEach((field) => {
    const sql = `
      SELECT DISTINCT ${field} as tags
      FROM images 
      WHERE user_id = ? 
        AND ${field} != '' 
        AND ${field} LIKE ?
      LIMIT ?
    `;

    const stmt = db.prepare(sql);
    const results = stmt.all(userId, `${prefix}%`, limit);

    results.forEach((row) => {
      if (row.tags) {
        const tags = row.tags.split(",").map((tag) => tag.trim());
        tags.forEach((tag) => {
          if (tag.toLowerCase().includes(prefix.toLowerCase()) && !suggestions.includes(tag)) {
            suggestions.push(tag);
          }
        });
      }
    });
  });

  return suggestions.slice(0, limit);
}

module.exports = {
  searchImagesByText,
  getSearchSuggestions,
};
