/**
 * 应用配置：app_config 表，列 user_id / key_type / enabled / api_key / updated_at。
 * 通过 getRowByKeyType、updateConfigRow 按 (user_id, key_type) 读写；云模型 cloud_model，高德 amap。
 */

const { db } = require("../db");

const TABLE = "app_config";

/** 云模型（阿里云百炼） */
const KEY_TYPE_CLOUD_MODEL = "cloud_model";
/** 高德逆地理 */
const KEY_TYPE_AMAP = "amap";

const VALID_KEY_TYPES = new Set([KEY_TYPE_CLOUD_MODEL, KEY_TYPE_AMAP]);

/**
 * 规范化并校验用户 ID。
 * @param {number|string} userId - 用户 ID。
 * @returns {number} 规范化后的用户 ID。
 */
function normalizeUserId(userId) {
  const n = Number(userId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`appSettingsModel: invalid user_id "${userId}"`);
  }
  return n;
}

/**
 * 确保用户在 app_config 中存在全部 key_type 行。
 * @param {number|string} userId - 用户 ID。
 * @returns {void} 无返回值。
 */
function ensureRows(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const now = Date.now();
  for (const keyType of [KEY_TYPE_CLOUD_MODEL, KEY_TYPE_AMAP]) {
    const exists = db
      .prepare(`SELECT 1 FROM ${TABLE} WHERE user_id = ? AND key_type = ?`)
      .get(normalizedUserId, keyType);
    if (!exists) {
      db
        .prepare(`INSERT INTO ${TABLE} (user_id, key_type, enabled, updated_at) VALUES (?, ?, 0, ?)`)
        .run(normalizedUserId, keyType, now);
    }
  }
}

/**
 * 将布尔值转为数据库整型布尔。
 * @param {boolean|number} value - 原始布尔值。
 * @returns {0|1} 0/1 值。
 */
function toBoolInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return 0;
}

/**
 * @param {number|string} userId
 * @param {string} keyType KEY_TYPE_CLOUD_MODEL | KEY_TYPE_AMAP
 * @returns {{ id: number, key_type: string, enabled: number, api_key: string|null, updated_at: number }|undefined}
 */
function getRowByKeyType(userId, keyType) {
  if (!VALID_KEY_TYPES.has(keyType)) {
    throw new Error(`appSettingsModel: invalid key_type "${keyType}"`);
  }
  const normalizedUserId = normalizeUserId(userId);
  ensureRows(normalizedUserId);
  return db
    .prepare(`SELECT * FROM ${TABLE} WHERE user_id = ? AND key_type = ?`)
    .get(normalizedUserId, keyType);
}

/**
 * 按列部分更新一行（仅出现字段会写入）。
 * @param {number|string} userId
 * @param {string} keyType
 * @param {{ enabled?: boolean|0|1, api_key?: string|null }} updates
 * @returns {void} 无返回值。
 */
function updateConfigRow(userId, keyType, updates) {
  if (!VALID_KEY_TYPES.has(keyType)) {
    throw new Error(`appSettingsModel: invalid key_type "${keyType}"`);
  }
  const normalizedUserId = normalizeUserId(userId);
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  ensureRows(normalizedUserId);
  const now = Date.now();
  const parts = [];
  const vals = [];
  if (updates.enabled !== undefined) {
    parts.push("enabled = ?");
    vals.push(toBoolInt(updates.enabled));
  }
  if (updates.api_key !== undefined) {
    parts.push("api_key = ?");
    vals.push(updates.api_key == null ? null : String(updates.api_key));
  }
  parts.push("updated_at = ?");
  vals.push(now);
  vals.push(normalizedUserId, keyType);
  db.prepare(`UPDATE ${TABLE} SET ${parts.join(", ")} WHERE user_id = ? AND key_type = ?`).run(...vals);
}

module.exports = {
  getRowByKeyType,
  updateConfigRow,
  KEY_TYPE_CLOUD_MODEL,
  KEY_TYPE_AMAP,
};
