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
 * 根据环境自动选择存储类型
 */
function getDefaultStorageType() {
  // 优先使用显式设置的STORAGE_TYPE
  if (process.env.STORAGE_TYPE) {
    return process.env.STORAGE_TYPE;
  }

  // 设置默认NODE_ENV（如果未设置）
  const nodeEnv = process.env.NODE_ENV || "development";

  // 根据NODE_ENV自动选择
  if (nodeEnv === "production") {
    return STORAGE_TYPES.ALIYUN_OSS;
  }

  // 开发环境默认使用本地存储
  return STORAGE_TYPES.LOCAL;
}

/**
 * 获取默认配置（动态计算，确保环境变量已加载）
 */
function getDefaultConfig() {
  const envAuthType = process.env.ALIYUN_OSS_AUTH_TYPE;
  const defaultAuthType = OSS_AUTH_TYPES.RAM;
  const finalAuthType = envAuthType || defaultAuthType;

  console.log("🔍 getDefaultConfig 调试信息：");
  console.log(`  process.env.ALIYUN_OSS_AUTH_TYPE: ${envAuthType || "undefined"}`);
  console.log(`  OSS_AUTH_TYPES.RAM: ${defaultAuthType}`);
  console.log(`  finalAuthType: ${finalAuthType}`);

  return {
    STORAGE_TYPE: getDefaultStorageType(),
    OSS_AUTH_TYPE: finalAuthType,
    LOCAL_BASE_URL: process.env.STORAGE_LOCAL_BASE_URL || "http://localhost:3000",
  };
}

/**
 * 默认配置（保持向后兼容）
 */
const DEFAULT_CONFIG = getDefaultConfig();

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
  getDefaultConfig,
  isValidStorageType,
  isValidOSSAuthType,
  getSupportedStorageTypes,
  getDefaultStorageType,
};
