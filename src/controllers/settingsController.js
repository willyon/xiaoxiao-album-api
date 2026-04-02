const axios = require("axios");

const { getSetting, setSetting } = require("../models/appSettingsModel");
const { getCloudCaptionProgress, enqueueCloudCaptionRebuildBatch } = require("../services/cloudCaptionService");

const CLOUD_ENABLED_KEY = "cloud_model_enabled";
const BAILIAN_KEY_KEY = "aliyun_bailian_api_key";
const PYTHON_SERVICE_URL =
  process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

function parseBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== "string") return false;
  const v = value.toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function getCloudModelSettings(req, res, next) {
  try {
    const enabledRow = getSetting(CLOUD_ENABLED_KEY);
    const keyRow = getSetting(BAILIAN_KEY_KEY);
    const enabled = parseBool(enabledRow?.value);
    const hasApiKey = Boolean(keyRow && keyRow.value && String(keyRow.value).trim() !== "");
    res.sendResponse({
      data: {
        enabled,
        hasApiKey,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function updateCloudModelSettings(req, res, next) {
  try {
    const { enabled, apiKey } = req.body || {};
    const normalizedEnabled = parseBool(enabled);
    setSetting(CLOUD_ENABLED_KEY, normalizedEnabled ? "true" : "false");

    if (typeof apiKey === "string") {
      const trimmed = apiKey.trim();
      if (trimmed) {
        setSetting(BAILIAN_KEY_KEY, trimmed);
      }
    }

    const enabledRow = getSetting(CLOUD_ENABLED_KEY);
    const keyRow = getSetting(BAILIAN_KEY_KEY);
    res.sendResponse({
      data: {
        enabled: parseBool(enabledRow?.value),
        hasApiKey: Boolean(keyRow && keyRow.value && String(keyRow.value).trim() !== ""),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function testCloudModelConnection(req, res, next) {
  try {
    const keyRow = getSetting(BAILIAN_KEY_KEY);
    const trimmed = (keyRow?.value || "").trim();
    if (!trimmed) {
      return res.sendResponse({
        data: { ok: false },
        message: "请输入有效的 API Key 后再测试。",
      });
    }

    const response = await axios.post(
      `${PYTHON_SERVICE_URL}/cloud/test-connection`,
      { apiKey: trimmed },
      { timeout: Number(process.env.CLOUD_MODEL_TEST_TIMEOUT_MS || 15000) },
    );
    const body = response.data || {};
    res.sendResponse({
      data: {
        ok: Boolean(body.ok),
        message: typeof body.message === "string" ? body.message : body.ok ? "连接成功，可以保存。" : "连接失败。",
      },
      message: body.message,
    });
  } catch (error) {
    if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
      return res.sendResponse({
        data: { ok: false },
        message: "连接云模型服务超时，请稍后重试。",
      });
    }
    next(error);
  }
}

async function getCloudCaptionProgressHandler(req, res, next) {
  try {
    res.sendResponse({
      data: getCloudCaptionProgress(),
    });
  } catch (error) {
    next(error);
  }
}

async function rebuildCloudCaption(req, res, next) {
  try {
    const limitPerBatch = Number(process.env.CLOUD_CAPTION_BATCH_LIMIT || 500);
    const enqueued = await enqueueCloudCaptionRebuildBatch(limitPerBatch);

    if (!enqueued) {
      return res.sendResponse({
        data: { enqueued: 0 },
        message: "没有需要补跑云模型的媒体。",
      });
    }

    res.sendResponse({
      data: { enqueued },
      message: `已为 ${enqueued} 条媒体创建云 caption 补跑任务。`,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCloudModelSettings,
  updateCloudModelSettings,
  testCloudModelConnection,
  getCloudCaptionProgressHandler,
  rebuildCloudCaption,
};

