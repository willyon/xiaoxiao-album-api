/**
 * 存储类型常量
 * 统一管理存储相关的字符串常量，便于维护和扩展
 */

/**
 * 存储适配器类型
 */
const STORAGE_TYPES = {
  LOCAL: "local",
  ALIYUN_OSS: "aliyun-oss",
  // 未来可以轻松添加新的存储类型
  // TENCENT_COS: "tencent-cos",
  // AWS_S3: "aws-s3",
  // QINIU: 'qiniu',
  // MINIO: 'minio',
};

/**
 * 阿里云OSS认证类型
 */
const OSS_AUTH_TYPES = {
  RAM: "ram",
  ACCESS_KEY: "accesskey",
  STS: "sts",
};

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  STORAGE_TYPE: process.env.STORAGE_TYPE || STORAGE_TYPES.LOCAL,
  OSS_AUTH_TYPE: process.env.ALIYUN_OSS_AUTH_TYPE || OSS_AUTH_TYPES.RAM,
  LOCAL_BASE_URL: process.env.STORAGE_LOCAL_BASE_URL || "http://localhost:3000",
};

/**
 * 验证存储类型是否支持
 * @param {string} type - 存储类型
 * @returns {boolean} 是否支持
 */
function isValidStorageType(type) {
  return Object.values(STORAGE_TYPES).includes(type);
}

/**
 * 验证OSS认证类型是否支持
 * @param {string} authType - 认证类型
 * @returns {boolean} 是否支持
 */
function isValidOSSAuthType(authType) {
  return Object.values(OSS_AUTH_TYPES).includes(authType);
}

/**
 * 获取所有支持的存储类型
 * @returns {Array<string>} 存储类型数组
 */
function getSupportedStorageTypes() {
  return Object.values(STORAGE_TYPES);
}

module.exports = {
  STORAGE_TYPES,
  OSS_AUTH_TYPES,
  DEFAULT_CONFIG,
  isValidStorageType,
  isValidOSSAuthType,
  getSupportedStorageTypes,
};
