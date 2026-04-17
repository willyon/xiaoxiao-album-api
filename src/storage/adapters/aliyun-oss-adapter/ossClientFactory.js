/*
 * @Description: 阿里云 OSS 客户端、鉴权与签名用 client 的创建（从 AliyunOSSAdapter 抽出）
 */

const OSS = require('ali-oss')
const Credential = require('@alicloud/credentials').default
const logger = require('../../../utils/logger')
const { OSS_AUTH_TYPES } = require('../../../constants/StorageTypes')

function getBucketPublicHost(bucket, region) {
  return `https://${bucket}.${region}.aliyuncs.com`
}

/**
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

    const client = new OSS({
      ...baseConfig,
      accessKeyId: s.accessKeyId,
      accessKeySecret: s.accessKeySecret,
      stsToken: s.securityToken,
      refreshSTSToken: async () => {
        const r = await credClient.getCredential()
        return {
          accessKeyId: r.accessKeyId,
          accessKeySecret: r.accessKeySecret,
          stsToken: r.securityToken
        }
      },
      refreshSTSTokenInterval: 10 * 60 * 1000
    })

    return { client, credential: credClient }
  }

  if (mode === OSS_AUTH_TYPES.ACCESS_KEY) {
    return {
      client: new OSS({
        ...baseConfig,
        accessKeyId: authCtx.accessKeyId,
        accessKeySecret: authCtx.accessKeySecret
      }),
      credential: undefined
    }
  }

  if (mode === OSS_AUTH_TYPES.STS) {
    return {
      client: new OSS({
        ...baseConfig,
        accessKeyId: authCtx.accessKeyId,
        accessKeySecret: authCtx.accessKeySecret,
        stsToken: authCtx.stsToken
      }),
      credential: undefined
    }
  }

  throw new Error(
    `Unsupported authentication type: ${mode}. Supported types: ${OSS_AUTH_TYPES.ROLE}, ${OSS_AUTH_TYPES.ACCESS_KEY}, ${OSS_AUTH_TYPES.STS}`
  )
}

/**
 * 自定义域名或内网 client 场景下，用于生成与对外 Host 一致的签名 URL
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

    return new OSS({
      ...signerBaseConfig,
      accessKeyId: s.accessKeyId,
      accessKeySecret: s.accessKeySecret,
      stsToken: s.securityToken,
      refreshSTSToken: async () => {
        const r = await credClient.getCredential()
        return {
          accessKeyId: r.accessKeyId,
          accessKeySecret: r.accessKeySecret,
          stsToken: r.securityToken
        }
      },
      refreshSTSTokenInterval: 10 * 60 * 1000
    })
  }

  if (authCtx.mode === OSS_AUTH_TYPES.ACCESS_KEY) {
    return new OSS({
      ...signerBaseConfig,
      accessKeyId: authCtx.accessKeyId,
      accessKeySecret: authCtx.accessKeySecret
    })
  }

  if (authCtx.mode === OSS_AUTH_TYPES.STS) {
    return new OSS({
      ...signerBaseConfig,
      accessKeyId: authCtx.accessKeyId,
      accessKeySecret: authCtx.accessKeySecret,
      stsToken: authCtx.stsToken
    })
  }

  return undefined
}

/**
 * 初始化主 client、可选 signer，以及适配器实例所需的字段
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
