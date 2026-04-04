/**
 * 高德逆地理：直接读取 app_config 中 key_type = amap 的 enabled、api_key。
 */

const { getRowByKeyType, KEY_TYPE_AMAP } = require("../models/appSettingsModel");

/** @returns {string} 非空则使用高德逆地理；空则走本地/全球 */
function getAmapApiKeyForGeocode() {
  const row = getRowByKeyType(KEY_TYPE_AMAP);
  if (!row) return "";
  const enabled = Number(row.enabled) === 1;
  const dbKey = (row.api_key != null ? String(row.api_key) : "").trim();
  if (enabled && dbKey) return dbKey;
  return "";
}

module.exports = {
  getAmapApiKeyForGeocode,
};
