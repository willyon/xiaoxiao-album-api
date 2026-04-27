/**
 * 媒体地点与文本归一化工具：提供地点键 SQL 片段、未知地点判断及文本数组规范化函数。
 */
/**
 * 单条媒体在筛选 / 地点相册分组中的「地点键」SQL 片段（优先 city，其次 province，否则 country）。
 * 无效：NULL、空串或仅空白（TRIM 后为空）；有效值取 TRIM 后结果。
 * @param {string} alias 表别名，如 i、media
 * @returns {string} 可嵌入 SQL 的表达式（可空）
 */
function sqlLocationKeyNullable(alias) {
  const a = alias;
  return `(
    CASE
      WHEN TRIM(COALESCE(${a}.city, '')) != '' THEN TRIM(${a}.city)
      WHEN TRIM(COALESCE(${a}.province, '')) != '' THEN TRIM(${a}.province)
      WHEN TRIM(COALESCE(${a}.country, '')) != '' THEN TRIM(${a}.country)
      ELSE NULL
    END
  )`;
}

/**
 * 生成地点分组键 SQL（空值回落为 unknown）。
 * @param {string} alias 表别名
 * @returns {string} SQL 表达式
 */
function sqlLocationAlbumKey(alias) {
  return `COALESCE(${sqlLocationKeyNullable(alias)}, 'unknown')`;
}

/**
 * 生成地点未知判断 SQL。
 * @param {string} alias 表别名
 * @returns {string} SQL 表达式
 */
function sqlLocationIsUnknown(alias) {
  return `(${sqlLocationKeyNullable(alias)} IS NULL)`;
}

/**
 * 规范化字符串数组：去空、去重、trim。
 * @param {any} input 输入值
 * @returns {string[]} 规范化后数组
 */
function normalizeTextArray(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const output = [];
  for (const item of input) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

module.exports = {
  sqlLocationKeyNullable,
  sqlLocationAlbumKey,
  sqlLocationIsUnknown,
  normalizeTextArray,
};
