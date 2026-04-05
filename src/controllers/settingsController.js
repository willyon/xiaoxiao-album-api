const axios = require("axios");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const {
  getRowByKeyType,
  updateConfigRow,
  KEY_TYPE_CLOUD_MODEL,
  KEY_TYPE_AMAP,
} = require("../models/appSettingsModel");
const { getCloudSkippedCount, enqueueCloudCaptionRebuildAll } = require("../services/cloudCaptionService");
const { getMapRegeoSkippedCount, enqueueMapRegeoRebuildAll } = require("../services/mapRegeoService");

/** 天安门附近 GCJ-02，用于连通性检测 */
const AMAP_TEST_LNG = 116.397428;
const AMAP_TEST_LAT = 39.90923;
const PYTHON_SERVICE_URL = process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

// 将请求体中的开关解析为「开」：按数值是否为 1（含布尔 true、数字 1、字符串 "1"）
function parseBool(value) {
  return Number(value) === 1;
}

// 读取云模型（百炼）开关与是否已配置 API Key
async function getCloudModelSettings(req, res, next) {
  try {
    const row = getRowByKeyType(KEY_TYPE_CLOUD_MODEL);
    const enabled = Number(row?.enabled) === 1;
    const hasApiKey = Boolean(row?.api_key && String(row.api_key).trim() !== "");
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

// 更新云模型启用状态；请求体中带非空 apiKey 时写入百炼 Key
async function updateCloudModelSettings(req, res, next) {
  try {
    const { enabled, apiKey } = req.body || {};
    const normalizedEnabled = parseBool(enabled);
    const patch = { enabled: normalizedEnabled };
    if (typeof apiKey === "string" && apiKey.trim()) {
      patch.api_key = apiKey.trim();
    }
    updateConfigRow(KEY_TYPE_CLOUD_MODEL, patch);

    const row = getRowByKeyType(KEY_TYPE_CLOUD_MODEL);
    res.sendResponse({
      data: {
        enabled: Number(row?.enabled) === 1,
        hasApiKey: Boolean(row?.api_key && String(row.api_key).trim() !== ""),
      },
    });
  } catch (error) {
    next(error);
  }
}

// 使用已保存的 Key 请求 Python 服务做云模型连通性检测
async function testCloudModelConnection(req, res, next) {
  try {
    const row = getRowByKeyType(KEY_TYPE_CLOUD_MODEL);
    const trimmed = (row?.api_key != null ? String(row.api_key) : "").trim();
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

// 返回云阶段为 skipped 的条数（与设置页历史补跑入队条件一致）
async function getCloudSkippedCountHandler(req, res, next) {
  try {
    const userId = req.user?.userId;
    res.sendResponse({
      data: getCloudSkippedCount(userId),
    });
  } catch (error) {
    next(error);
  }
}

// 为历史媒体入队云 caption 补跑（后端按批循环直至清空）
async function rebuildCloudCaption(req, res, next) {
  try {
    const limitPerBatch = Number(process.env.CLOUD_CAPTION_BATCH_LIMIT || 500);
    const userId = req.user?.userId;
    const totalEnqueued = await enqueueCloudCaptionRebuildAll(limitPerBatch, userId);

    res.sendResponse({
      data: { enqueued: totalEnqueued },
    });
  } catch (error) {
    next(error);
  }
}

// 读取高德逆地理开关与是否已保存 Web 服务 Key
async function getAmapSettings(req, res, next) {
  try {
    const row = getRowByKeyType(KEY_TYPE_AMAP);
    const enabled = Number(row?.enabled) === 1;
    const hasApiKey = Boolean(row?.api_key && String(row.api_key).trim() !== "");
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

// 更新高德启用状态与非空时写入 Web 服务 Key
async function updateAmapSettings(req, res, next) {
  try {
    const { enabled, apiKey } = req.body || {};
    const normalizedEnabled = parseBool(enabled);
    const patch = { enabled: normalizedEnabled };
    if (typeof apiKey === "string" && apiKey.trim()) {
      patch.api_key = apiKey.trim();
    }
    updateConfigRow(KEY_TYPE_AMAP, patch);

    const row = getRowByKeyType(KEY_TYPE_AMAP);
    res.sendResponse({
      data: {
        enabled: Number(row?.enabled) === 1,
        hasApiKey: Boolean(row?.api_key && String(row.api_key).trim() !== ""),
      },
    });
  } catch (error) {
    next(error);
  }
}

// 使用已保存的 Key 调用高德 regeo 接口做连通性检测
async function testAmapConnection(req, res, next) {
  try {
    const row = getRowByKeyType(KEY_TYPE_AMAP);
    const trimmed = (row?.api_key != null ? String(row.api_key) : "").trim();
    if (!trimmed) {
      return res.sendResponse({
        data: { ok: false },
        message: "请先在设置中保存有效的 Web 服务 Key 后再测试。",
      });
    }

    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(trimmed)}&location=${AMAP_TEST_LNG},${AMAP_TEST_LAT}&extensions=base&output=json`;
    const response = await axios.get(url, { timeout: Number(process.env.AMAP_TEST_TIMEOUT_MS || 8000) });
    const body = response.data || {};
    const ok = body.status === "1" && body.regeocode;
    res.sendResponse({
      data: {
        ok,
        message: ok ? "高德逆地理接口可用。" : (body.info || "调用失败，请检查 Key 类型与配额。"),
      },
    });
  } catch (error) {
    if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
      return res.sendResponse({
        data: { ok: false },
        message: "请求高德超时，请稍后重试。",
      });
    }
    next(error);
  }
}

async function getMapRegeoSkippedCountHandler(req, res, next) {
  try {
    const userId = req.user?.userId;
    res.sendResponse({
      data: getMapRegeoSkippedCount(userId),
    });
  } catch (error) {
    next(error);
  }
}

async function rebuildMapRegeo(req, res, next) {
  try {
    const row = getRowByKeyType(KEY_TYPE_AMAP);
    const amapReady = Number(row?.enabled) === 1 && Boolean(row?.api_key && String(row.api_key).trim() !== "");
    if (!amapReady) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.UNSUPPORTED_OPERATION,
        messageType: "error",
        message: "高德逆地理未启用或未配置 Web 服务 Key，无法补跑。",
      });
    }

    const limitPerBatch = Number(process.env.MAP_REGEO_BATCH_LIMIT || 500);
    const userId = req.user?.userId;
    const totalEnqueued = await enqueueMapRegeoRebuildAll(limitPerBatch, userId);

    res.sendResponse({
      data: { enqueued: totalEnqueued },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCloudModelSettings,
  updateCloudModelSettings,
  testCloudModelConnection,
  getCloudSkippedCountHandler,
  rebuildCloudCaption,
  getAmapSettings,
  updateAmapSettings,
  testAmapConnection,
  getMapRegeoSkippedCountHandler,
  rebuildMapRegeo,
};

