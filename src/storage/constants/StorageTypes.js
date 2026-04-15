/**
 * 存储类型常量
 * 统一管理存储相关的字符串常量，便于维护和扩展
 */

/**
 * 存储适配器类型
 */
const STORAGE_TYPES = {
  LOCAL: 'local',
  ALIYUN_OSS: 'aliyun-oss'
  // 未来可以轻松添加新的存储类型
  // TENCENT_COS: "tencent-cos",
  // AWS_S3: "aws-s3",
  // QINIU: 'qiniu',
  // MINIO: 'minio',
}

const ALIYUN_OSS_BUCKET_NAME = process.env.NODE_ENV === 'development' ? process.env.ALIYUN_OSS_BUCKET_DEV : process.env.ALIYUN_OSS_BUCKET_PROD

/**
 * 阿里云OSS认证类型
 */
const OSS_AUTH_TYPES = {
  ROLE: 'ecs_ram_role',
  ACCESS_KEY: 'accesskey',
  STS: 'sts'
}

// oss实例化基本参数
const OSS_BASE_CONFIG = {
  region: process.env.ALIYUN_OSS_REGION,
  bucket: ALIYUN_OSS_BUCKET_NAME,
  customDomain: process.env.ALIYUN_OSS_CUSTOM_DOMAIN,
  timeout: parseInt(process.env.ALIYUN_OSS_TIMEOUT) || 60000,
  uploadConcurrency: parseInt(process.env.ALIYUN_OSS_UPLOAD_CONCURRENCY) || 5,
  preferInternal: _useOSSInternal()
}

/**
 * 根据环境自动选择存储类型
 */
function getDefaultStorageType() {
  return process.env.STORAGE_TYPE || STORAGE_TYPES.ALIYUN_OSS
}

function _getOSSAuthType() {
  return process.env.NODE_ENV === 'development' ? OSS_AUTH_TYPES.ACCESS_KEY : process.env.ALIYUN_OSS_AUTH_TYPE || OSS_AUTH_TYPES.ROLE
}

function _useOSSInternal() {
  return process.env.NODE_ENV === 'development' ? false : process.env.OSS_BUCKET_URL_PREFER_INTERNAL !== 'false'
}

function _getLocalBaseUrl() {
  return process.env.NODE_ENV === 'production'
    ? process.env.API_BASE_URL_ALIYUN_ECS
    : process.env.API_BASE_URL_LOCAL
      ? process.env.API_BASE_URL_LOCAL
      : 'http://localhost:3000'
}

/**
 * 获取存储配置（动态计算，确保环境变量已加载）
 */
function getStorageConfig() {
  return {
    storageType: getDefaultStorageType(),
    [STORAGE_TYPES.LOCAL]: {
      storageType: STORAGE_TYPES.LOCAL,
      baseUrl: _getLocalBaseUrl()
    },
    [STORAGE_TYPES.ALIYUN_OSS]: {
      storageType: STORAGE_TYPES.ALIYUN_OSS,
      ossAuthType: _getOSSAuthType(),
      [OSS_AUTH_TYPES.ROLE]: {
        authType: OSS_AUTH_TYPES.ROLE,
        ...OSS_BASE_CONFIG,
        ramRoleName: process.env.ALIYUN_ECS_RAM_ROLE_NAME
      },
      [OSS_AUTH_TYPES.ACCESS_KEY]: {
        authType: OSS_AUTH_TYPES.ACCESS_KEY,
        ...OSS_BASE_CONFIG,
        accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET
      },
      [OSS_AUTH_TYPES.STS]: {
        authType: OSS_AUTH_TYPES.STS,
        ...OSS_BASE_CONFIG
      }
    }
  }
}

module.exports = {
  STORAGE_TYPES,
  OSS_AUTH_TYPES,
  getStorageConfig,
  getDefaultStorageType
}
