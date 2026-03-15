/**
 * 根据请求语言为筛选选项（场景/物体）返回展示文案
 * 供 searchController 在返回 scene/object 选项时调用，与 taxonomy 保持一致
 */
const { mapSceneLabel } = require("../constants/sceneTaxonomy");
const { mapObjectLabel } = require("../constants/objectTaxonomy");

function capitalize(str) {
  if (!str || typeof str !== "string") return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * @param {'scene'|'object'} type
 * @param {string} value - canonical 或 raw 值
 * @param {string} lang - 'zh' | 'en' 等，来自 req.userLanguage
 * @returns {string} 展示用 label
 */
function getLocalizedFilterLabel(type, value, lang) {
  if (!value || typeof value !== "string") return value;
  const normalizedLang = (lang || "zh").toLowerCase().startsWith("en") ? "en" : "zh";

  if (type === "scene") {
    const entry = mapSceneLabel(value);
    if (normalizedLang === "zh") return entry.zh || value;
    return capitalize(entry.canonical) || value;
  }

  if (type === "object") {
    const entry = mapObjectLabel(value);
    if (normalizedLang === "zh") return entry.zh || value;
    return capitalize(entry.canonical) || value;
  }

  return value;
}

module.exports = {
  getLocalizedFilterLabel,
};
