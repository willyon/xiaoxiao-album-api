/*
 * @Description: OSS 表单直传策略与签名（从 AliyunOSSAdapter 抽出）
 */

const logger = require('../../../utils/logger')
const { generatePolicySignature, buildOSSCallbackUrl } = require('../../../utils/ossUtils')
const { OSS_AUTH_TYPES } = require('../../../constants/StorageTypes')
const { getBucketPublicHost } = require('./ossClientFactory')

/**
 * @param {object} adapter - AliyunOSSAdapter 实例（需已具备 config、credential、accessKeyId 等字段）
 */
async function getUploadSignature(adapter, { storageKey, contentType, contentLength, userId, sessionId }) {
  try {
    const callbackUrl = buildOSSCallbackUrl()

    const callbackBody = JSON.stringify({
      userId,
      storageKey,
      fileSize: contentLength,
      imageHash: storageKey.split('/').pop().split('.')[0],
      sessionId
    })

    logger.info({
      message: 'OSS回调参数详情',
      details: {
        callbackUrl,
        callbackBody
      }
    })

    const policy = {
      expiration: new Date(Date.now() + 3600 * 1000).toISOString(),
      conditions: [
        ['content-length-range', 0, contentLength],
        ['eq', '$bucket', adapter.bucket],
        ['eq', '$key', storageKey],
        ['eq', '$Content-Type', contentType]
      ]
    }

    const policyString = Buffer.from(JSON.stringify(policy)).toString('base64')

    let signature
    let accessKeyId
    let securityToken

    const mode = (adapter.config.authType || OSS_AUTH_TYPES.ROLE).toLowerCase()
    if (mode === OSS_AUTH_TYPES.ROLE) {
      const sts = await adapter.credential.getCredential()
      accessKeyId = sts.accessKeyId
      securityToken = sts.securityToken
      const accessKeySecret = sts.accessKeySecret
      signature = generatePolicySignature(policyString, accessKeySecret)

      logger.info({
        message: '使用 ECS 角色 STS 临时凭证生成签名',
        details: {
          accessKeyId: accessKeyId ? accessKeyId.substring(0, 8) + '...' : undefined,
          expiresAt: sts.expiration
        }
      })
    } else if (mode === OSS_AUTH_TYPES.STS) {
      accessKeyId = adapter.accessKeyId
      securityToken = adapter.config.stsToken
      signature = generatePolicySignature(policyString, adapter.accessKeySecret)
    } else {
      accessKeyId = adapter.accessKeyId
      signature = generatePolicySignature(policyString, adapter.accessKeySecret)
    }

    const callbackParam = {
      callbackUrl,
      callbackBody,
      callbackBodyType: 'application/json'
    }

    const callbackBase64 = Buffer.from(JSON.stringify(callbackParam)).toString('base64')

    const resp = {
      storageKey,
      policy: policyString,
      signature,
      accessKeyId,
      successActionStatus: '200',
      contentType,
      callback: callbackBase64,
      host: getBucketPublicHost(adapter.bucket, adapter.region)
    }
    if (securityToken) {
      resp.securityToken = securityToken
    }
    return resp
  } catch (error) {
    logger.error({
      message: 'Failed to generate upload signature',
      details: { storageKey, contentType, contentLength, userId, error: error.message }
    })
    throw error
  }
}

module.exports = { getUploadSignature }
