const { getRowByKeyType, KEY_TYPE_CLOUD_MODEL } = require('../models/appSettingsModel')

/**
 * 统一获取云模型配置（app_config user_id + key_type = cloud_model）：
 * - enabled=false 或无 key 时返回 null
 * - enabled=true 且有 key 时返回 { enabled, provider, api_key }
 */
function getCloudConfigForAnalysis(userId) {
  try {
    const row = getRowByKeyType(userId, KEY_TYPE_CLOUD_MODEL)
    const enabled = Number(row?.enabled) === 1
    const apiKey = (row?.api_key != null ? String(row.api_key) : '').trim()
    if (!enabled || !apiKey) return null
    return {
      enabled: true,
      provider: 'aliyun-bailian',
      api_key: apiKey
    }
  } catch {
    return null
  }
}

module.exports = {
  getCloudConfigForAnalysis
}
