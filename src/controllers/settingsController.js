const axios = require('axios')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const { getRowByKeyType, updateConfigRow, KEY_TYPE_CLOUD_MODEL, KEY_TYPE_AMAP } = require('../services/appSettingsService')
const { getCloudSkippedCount, enqueueCloudCaptionRebuildAll } = require('../services/cloudCaptionService')
const { getMapRegeoSkippedCount, enqueueMapRegeoRebuildAll } = require('../services/mapRegeoService')
const asyncHandler = require('../utils/asyncHandler')

/** 天安门附近 GCJ-02，用于高德测连 */
const AMAP_TEST_LNG = 116.397428
const AMAP_TEST_LAT = 39.90923
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL

function parseBool(value) {
  return Number(value) === 1
}

/** 云模型 / 高德设置行 → 前端统一结构 */
function toSettingsPayload(row) {
  return {
    enabled: Number(row?.enabled) === 1,
    hasApiKey: Boolean(row?.api_key && String(row.api_key).trim() !== '')
  }
}

/** 通用：读取 app_settings 中某一 KEY_TYPE 的开关与是否已配 Key */
function createGetSettingsHandler(keyType) {
  return asyncHandler(async function getSettings(req, res) {
    const userId = req.user?.userId
    const row = getRowByKeyType(userId, keyType)
    res.sendResponse({ data: toSettingsPayload(row) })
  })
}

/** 通用：更新开关 + 可选 apiKey，并回读同一 keyType */
function createUpdateSettingsHandler(keyType) {
  return asyncHandler(async function updateSettings(req, res) {
    const userId = req.user?.userId
    const { enabled, apiKey } = req.body || {}
    const patch = { enabled: parseBool(enabled) }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      patch.api_key = apiKey.trim()
    }
    updateConfigRow(userId, keyType, patch)
    const row = getRowByKeyType(userId, keyType)
    res.sendResponse({ data: toSettingsPayload(row) })
  })
}

const getCloudModelSettings = createGetSettingsHandler(KEY_TYPE_CLOUD_MODEL)
const updateCloudModelSettings = createUpdateSettingsHandler(KEY_TYPE_CLOUD_MODEL)
const getAmapSettings = createGetSettingsHandler(KEY_TYPE_AMAP)
const updateAmapSettings = createUpdateSettingsHandler(KEY_TYPE_AMAP)

// 测连 URL 与协议不同，保持独立实现
async function testCloudModelConnection(req, res, next) {
  try {
    const userId = req.user?.userId
    const row = getRowByKeyType(userId, KEY_TYPE_CLOUD_MODEL)
    const trimmed = (row?.api_key != null ? String(row.api_key) : '').trim()
    if (!trimmed) {
      return res.sendResponse({
        data: { ok: false },
        message: '请输入有效的 API Key 后再测试。'
      })
    }

    const response = await axios.post(
      `${PYTHON_SERVICE_URL}/cloud/test-connection`,
      { apiKey: trimmed },
      { timeout: Number(process.env.CLOUD_MODEL_TEST_TIMEOUT_MS || 15000) }
    )
    const body = response.data || {}
    res.sendResponse({
      data: {
        ok: Boolean(body.ok),
        message: typeof body.message === 'string' ? body.message : body.ok ? '连接成功，可以保存。' : '连接失败。'
      },
      message: body.message
    })
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      return res.sendResponse({
        data: { ok: false },
        message: '连接云模型服务超时，请稍后重试。'
      })
    }
    next(error)
  }
}

async function getCloudSkippedCountHandler(req, res) {
  const userId = req.user?.userId
  res.sendResponse({
    data: getCloudSkippedCount(userId)
  })
}

async function rebuildCloudCaption(req, res) {
  const limitPerBatch = Number(process.env.CLOUD_CAPTION_BATCH_LIMIT || 500)
  const userId = req.user?.userId
  const totalEnqueued = await enqueueCloudCaptionRebuildAll(limitPerBatch, userId)

  res.sendResponse({
    data: { enqueued: totalEnqueued }
  })
}

async function testAmapConnection(req, res, next) {
  try {
    const userId = req.user?.userId
    const row = getRowByKeyType(userId, KEY_TYPE_AMAP)
    const trimmed = (row?.api_key != null ? String(row.api_key) : '').trim()
    if (!trimmed) {
      return res.sendResponse({
        data: { ok: false },
        message: '请先在设置中保存有效的 Web 服务 Key 后再测试。'
      })
    }

    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(trimmed)}&location=${AMAP_TEST_LNG},${AMAP_TEST_LAT}&extensions=base&output=json`
    const response = await axios.get(url, { timeout: Number(process.env.AMAP_TEST_TIMEOUT_MS || 8000) })
    const body = response.data || {}
    const ok = body.status === '1' && body.regeocode
    res.sendResponse({
      data: {
        ok,
        message: ok ? '高德逆地理接口可用。' : body.info || '调用失败，请检查 Key 类型与配额。'
      }
    })
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      return res.sendResponse({
        data: { ok: false },
        message: '请求高德超时，请稍后重试。'
      })
    }
    next(error)
  }
}

async function getMapRegeoSkippedCountHandler(req, res) {
  const userId = req.user?.userId
  res.sendResponse({
    data: getMapRegeoSkippedCount(userId)
  })
}

async function rebuildMapRegeo(req, res) {
  const userId = req.user?.userId
  const row = getRowByKeyType(userId, KEY_TYPE_AMAP)
  const amapReady = Number(row?.enabled) === 1 && Boolean(row?.api_key && String(row.api_key).trim() !== '')
  if (!amapReady) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.UNSUPPORTED_OPERATION,
      messageType: 'error',
      message: '高德逆地理未启用或未配置 Web 服务 Key，无法补跑。'
    })
  }

  const limitPerBatch = Number(process.env.MAP_REGEO_BATCH_LIMIT || 500)
  const totalEnqueued = await enqueueMapRegeoRebuildAll(limitPerBatch, userId)

  res.sendResponse({
    data: { enqueued: totalEnqueued }
  })
}

module.exports = {
  getCloudModelSettings,
  updateCloudModelSettings,
  testCloudModelConnection,
  getCloudSkippedCountHandler: asyncHandler(getCloudSkippedCountHandler),
  rebuildCloudCaption: asyncHandler(rebuildCloudCaption),
  getAmapSettings,
  updateAmapSettings,
  testAmapConnection,
  getMapRegeoSkippedCountHandler: asyncHandler(getMapRegeoSkippedCountHandler),
  rebuildMapRegeo: asyncHandler(rebuildMapRegeo)
}
