const { getSetting } = require("../models/appSettingsModel");

const CLOUD_ENABLED_KEY = "cloud_model_enabled";
const BAILIAN_KEY_KEY = "aliyun_bailian_api_key";

function parseBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== "string") return false;
  const v = value.toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * 统一获取云模型配置：
 * - enabled=false 或无 key 时返回 null
 * - enabled=true 且有 key 时返回 { enabled, provider, api_key }
 */
function getCloudConfigForAnalysis() {
  try {
    const enabledRow = getSetting(CLOUD_ENABLED_KEY);
    const keyRow = getSetting(BAILIAN_KEY_KEY);
    const enabled = parseBool(enabledRow?.value);
    const apiKey = (keyRow?.value || "").trim();
    if (!enabled || !apiKey) return null;
    return {
      enabled: true,
      provider: "aliyun-bailian",
      api_key: apiKey,
    };
  } catch (_e) {
    return null;
  }
}

module.exports = {
  getCloudConfigForAnalysis,
};

