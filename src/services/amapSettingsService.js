/**
 * 高德逆地理：按 user_id 读取 app_config 中 key_type = amap 的 enabled、api_key。
 */

const { getRowByKeyType, KEY_TYPE_AMAP } = require('../models/appSettingsModel')

/**
 * 读取用户可用的高德逆地理 API Key。
 * @param {number|string} userId - 用户 ID。
 * @returns {string} 非空则使用高德逆地理；空则走本地/全球。
 */
function getAmapApiKeyForGeocode(userId) {
  const row = getRowByKeyType(userId, KEY_TYPE_AMAP)
  if (!row) return ''
  const enabled = Number(row.enabled) === 1
  const dbKey = (row.api_key != null ? String(row.api_key) : '').trim()
  if (enabled && dbKey) return dbKey
  return ''
}

module.exports = {
  getAmapApiKeyForGeocode
}
