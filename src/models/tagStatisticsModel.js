/*
 * 标签统计表访问层
 */

const { db } = require("../services/database");

/**
 * 获取指定类型的热门标签
 * @param {Object} params
 * @param {"object"|"scene"|"keyword"} params.tagType
 * @param {number} params.limit
 */
function getPopularTags({ tagType, limit }) {
  const stmt = db.prepare(
    `
      SELECT tag_name, count, last_updated
      FROM tag_statistics
      WHERE tag_type = ?
      ORDER BY count DESC, last_updated DESC
      LIMIT ?
    `,
  );
  return stmt.all(tagType, limit);
}

module.exports = {
  getPopularTags,
};
