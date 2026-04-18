/*
 * @Description: 阿里云 OSS 客户端、鉴权与签名用 client 的创建（从 AliyunOSSAdapter 抽出）
 */

const OSS = require('ali-oss')
const Credential = require('@alicloud/credentials').default
const logger = require('../../../utils/logger')
const { OSS_AUTH_TYPES } = require('../../../constants/storageTypes')

/**
 * 获取 OSS Bucket 对外访问 Host。
 * @param {string} bucket - Bucket 名称。
 * @param {string} region - 区域标识。
 * @returns {string} 公网 Host。
 */
function getBucketPublicHost(bucket, region) {
  return `https://${bucket}.${region}.aliyuncs.com`
}

/**
 * 预处理 OSS 鉴权上下文与关键配置。
 * @param {object} config - OSS 配置对象。
 * @returns {{
 *   authCtx: object,
 *   bucket: string,
 *   region: string,
 *   accessKeyId?: string,
 *   accessKeySecret?: string,
 *   stsToken?: string
 * }}
 */
function prepareAuthContext(config) {
  const required = ['region', 'bucket']
  const missing = required.filter((k) => !config[k])
  if (missing.length) throw new Error(`AliyunOSS config missing required fields: ${missing.join(', ')}`)

  const bucket = config.bucket
  const region = config.region

  const mode = (config?.authType || OSS_AUTH_TYPES.ROLE).toLowerCase()

  if (mode === OSS_AUTH_TYPES.ACCESS_KEY) {
    const need = ['accessKeyId', 'accessKeySecret']
    const lack = need.filter((k) => !config[k])
    if (lack.length) throw new Error(`AccessKey authentication missing required fields: ${lack.join(', ')}`)
    return {
      authCtx: { mode, accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret },
      bucket,
      region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret
    }
  }

  if (mode === OSS_AUTH_TYPES.STS) {
    const need = ['accessKeyId', 'accessKeySecret', 'stsToken']
    const lack = need.filter((k) => !config[k])
    if (lack.length) throw new Error(`STS authentication missing required fields: ${lack.join(', ')}`)
    return {
      authCtx: {
        mode,
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        stsToken: config.stsToken
      },
      bucket,
      region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      stsToken: config.stsToken
    }
  }

  return {
    authCtx: { mode: OSS_AUTH_TYPES.ROLE },
    bucket,
    region
  }
}

/**
 * 构建 OSS 客户端基础配置与 baseUrl。
 * @param {object} config - OSS 配置。
 * @param {string} bucket - Bucket 名称。
 * @param {string} region - 区域标识。
 * @returns {{baseConfig:object,baseUrl:string}} 基础配置与基础 URL。
 */
function buildBaseConfig(config, bucket, region) {
  const baseConfig = {
    region,
    bucket,
    timeout: config.timeout || 300000
  }

  const baseUrl = config.customDomain || getBucketPublicHost(bucket, region)

  if (config.preferInternal) {
    baseConfig.internal = true
  }

  return { baseConfig, baseUrl }
}

/**
 * 按鉴权类型创建主 OSS client。
 * @param {object} baseConfig - OSS 基础配置。
 * @param {object} authCtx - 鉴权上下文。
 * @param {object} config - 原始配置。
 * @returns {Promise<{client:object,credential?:object}>} client 与可选 credential。
 */
async function createClientByAuthType(baseConfig, authCtx, config) {
  const mode = authCtx.mode

  if (mode === OSS_AUTH_TYPES.ROLE) {
    const credClient =
      new Credential({
        type: config.authType,
        roleName: config.ramRoleName,
        disableIMDSv1: true,
        timeout: 3000
      })

    const s = await credClient.getCredential()

    const client = new OSS(buildClientOptionsByAuth({ baseConfig, authCtx, credential: credClient, seedCredential: s }))

    return { client, credential: credClient }
  }

  if (mode === OSS_AUTH_TYPES.ACCESS_KEY) {
    return {
      client: new OSS(buildClientOptionsByAuth({ baseConfig, authCtx })),
      credential: undefined
    }
  }

  if (mode === OSS_AUTH_TYPES.STS) {
    return {
      client: new OSS(buildClientOptionsByAuth({ baseConfig, authCtx })),
      credential: undefined
    }
  }

  throw new Error(
    `Unsupported authentication type: ${mode}. Supported types: ${OSS_AUTH_TYPES.ROLE}, ${OSS_AUTH_TYPES.ACCESS_KEY}, ${OSS_AUTH_TYPES.STS}`
  )
}

function buildClientOptionsByAuth({ baseConfig, authCtx, credential, seedCredential }) {
  if (authCtx.mode === OSS_AUTH_TYPES.ROLE) {
    if (!credential || !seedCredential) {
      throw new Error('ROLE auth requires credential client and seed credential')
    }
    return {
      ...baseConfig,
      accessKeyId: seedCredential.accessKeyId,
      accessKeySecret: seedCredential.accessKeySecret,
      stsToken: seedCredential.securityToken,
      refreshSTSToken: async () => {
        const r = await credential.getCredential()
        return {
          accessKeyId: r.accessKeyId,
          accessKeySecret: r.accessKeySecret,
          stsToken: r.securityToken
        }
      },
      refreshSTSTokenInterval: 10 * 60 * 1000
    }
  }
  if (authCtx.mode === OSS_AUTH_TYPES.ACCESS_KEY) {
    return {
      ...baseConfig,
      accessKeyId: authCtx.accessKeyId,
      accessKeySecret: authCtx.accessKeySecret
    }
  }
  if (authCtx.mode === OSS_AUTH_TYPES.STS) {
    return {
      ...baseConfig,
      accessKeyId: authCtx.accessKeyId,
      accessKeySecret: authCtx.accessKeySecret,
      stsToken: authCtx.stsToken
    }
  }
  throw new Error(
    `Unsupported authentication type: ${authCtx.mode}. Supported types: ${OSS_AUTH_TYPES.ROLE}, ${OSS_AUTH_TYPES.ACCESS_KEY}, ${OSS_AUTH_TYPES.STS}`
  )
}

/**
 * 自定义域名或内网 client 场景下，用于生成与对外 Host 一致的签名 URL
 * @param {object} config - OSS 配置。
 * @param {string} bucket - Bucket 名称。
 * @param {string} region - 区域标识。
 * @param {object} authCtx - 鉴权上下文。
 * @param {object} credential - 角色凭证对象。
 * @returns {Promise<object|undefined>} signer client。
 */
async function createSignerClient(config, bucket, region, authCtx, credential) {
  let configObj = {}
  if (config.customDomain) {
    configObj.endpoint = config.customDomain.startsWith('http')
      ? config.customDomain.replace(/\/+$/, '')
      : `https://${config.customDomain}`
    configObj.cname = true
  }

  const signerBaseConfig = { region, bucket, ...configObj }

  if (authCtx.mode === OSS_AUTH_TYPES.ROLE) {
    const credClient = credential
    const s = await credClient.getCredential()
    return new OSS(buildClientOptionsByAuth({ baseConfig: signerBaseConfig, authCtx, credential: credClient, seedCredential: s }))
  }

  if (authCtx.mode === OSS_AUTH_TYPES.ACCESS_KEY) {
    return new OSS(buildClientOptionsByAuth({ baseConfig: signerBaseConfig, authCtx }))
  }

  if (authCtx.mode === OSS_AUTH_TYPES.STS) {
    return new OSS(buildClientOptionsByAuth({ baseConfig: signerBaseConfig, authCtx }))
  }

  return undefined
}

/**
 * 初始化主 client、可选 signer，以及适配器实例所需的字段
 * @param {object} config - OSS 配置。
 * @returns {Promise<{client:object,signer?:object,credential?:object,baseUrl:string,bucket:string,region:string,accessKeyId?:string,accessKeySecret?:string,stsToken?:string}>} 初始化结果。
 */
async function initAliyunOssClients(config) {
  const prepared = prepareAuthContext(config)
  const { authCtx, bucket, region, accessKeyId, accessKeySecret, stsToken } = prepared
  const { baseConfig, baseUrl } = buildBaseConfig(config, bucket, region)

  const { client, credential } = await createClientByAuthType(baseConfig, authCtx, config)

  let signer
  if (config.customDomain || config.preferInternal) {
    signer = await createSignerClient(config, bucket, region, authCtx, credential)
  }

  logger.info({
    message: '阿里云OSS已连接(异步初始化)',
    details: {
      region,
      bucket,
      endpoint: baseConfig.endpoint || '(public by region)',
      authType: authCtx.mode
    }
  })

  return {
    client,
    signer,
    credential,
    baseUrl,
    bucket,
    region,
    accessKeyId,
    accessKeySecret,
    stsToken
  }
}

module.exports = {
  initAliyunOssClients,
  getBucketPublicHost
}
